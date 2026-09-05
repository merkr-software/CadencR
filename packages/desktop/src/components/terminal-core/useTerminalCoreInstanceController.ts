import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type MutableRefObject,
} from "react";
import type { TerminalTransport } from "celeritty";
import type { TerminalEngine as Terminal } from "./terminal-engine";
import { useTerminalOptions } from "./useTerminalOptions";
import { useTerminalWebSocket } from "@/hooks/useTerminalWebSocket";
import { useCelerittyTransport } from "./useCelerittyTransport";
import { useCelerittyTerminal } from "./useCelerittyTerminal";
import { toControlChar } from "@/lib/terminal-keys";
import { useLinkRouting } from "@/components/links/LinkRoutingContext";
import { attachTouchScroll } from "./terminal-touch-scroll";
import { attachNavigationKeys } from "./terminal-navigation-keys";
import type {
  TerminalCoreInstanceProps,
  TerminalCoreInstanceHandle,
} from "./TerminalCoreInstance.types";

/** Fixed spawn size, matching the Neovim pane's own precedent: the PTY spawns
 * at a guessed size, and `Terminal.attach()` sends the real measured grid
 * immediately once attached — see `useCelerittyTerminal`. */
const INITIAL_COLUMNS = 80;
const INITIAL_ROWS = 24;

interface CoreRefs {
  ptyIdRef: MutableRefObject<string | null>;
  mountedRef: MutableRefObject<boolean>;
  shouldKillRef: MutableRefObject<boolean>;
  initialCommandRef: MutableRefObject<string | undefined>;
  onInitialCommandConsumedRef: MutableRefObject<(() => void) | undefined>;
  initialNoticeRef: MutableRefObject<string | undefined>;
  onInitialNoticeConsumedRef: MutableRefObject<(() => void) | undefined>;
  ctrlArmedRef: MutableRefObject<boolean>;
  onConsumeCtrlRef: MutableRefObject<(() => void) | undefined>;
  onTerminalFocusRef: MutableRefObject<(() => void) | undefined>;
  noticeConsumedRef: MutableRefObject<boolean>;
  commandConsumedRef: MutableRefObject<boolean>;
}

function useCoreRefs(props: TerminalCoreInstanceProps): CoreRefs {
  const stableRefsRef = useRef<CoreRefs | null>(null);
  stableRefsRef.current ??= {
    ptyIdRef: { current: props.existingPtyId ?? null },
    mountedRef: { current: true },
    shouldKillRef: { current: props.killOnUnmount ?? false },
    initialCommandRef: { current: props.initialCommand },
    onInitialCommandConsumedRef: { current: props.onInitialCommandConsumed },
    initialNoticeRef: { current: props.initialNotice },
    onInitialNoticeConsumedRef: { current: props.onInitialNoticeConsumed },
    ctrlArmedRef: { current: props.ctrlArmed ?? false },
    onConsumeCtrlRef: { current: props.onConsumeCtrl },
    onTerminalFocusRef: { current: props.onTerminalFocus },
    noticeConsumedRef: { current: false },
    commandConsumedRef: { current: false },
  };
  const refs = stableRefsRef.current;

  refs.shouldKillRef.current = props.killOnUnmount ?? false;
  refs.initialCommandRef.current = props.initialCommand;
  refs.onInitialCommandConsumedRef.current = props.onInitialCommandConsumed;
  refs.initialNoticeRef.current = props.initialNotice;
  refs.onInitialNoticeConsumedRef.current = props.onInitialNoticeConsumed;
  refs.ctrlArmedRef.current = props.ctrlArmed ?? false;
  refs.onConsumeCtrlRef.current = props.onConsumeCtrl;
  refs.onTerminalFocusRef.current = props.onTerminalFocus;

  return refs;
}

interface ShellSocket {
  connection: ReturnType<typeof useTerminalWebSocket>;
  transport: TerminalTransport;
  ptyReady: boolean;
  errorMessage: string | null;
}

/**
 * Owns the socket and the `TerminalTransport` built on top of it. Split out
 * of the controller purely to stay under the 100-line function budget — the
 * two pieces are read together everywhere they're used.
 */
function useShellSocket(props: TerminalCoreInstanceProps, refs: CoreRefs): ShellSocket {
  const [ptyReady, setPtyReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // One-shot: a reconnect that can't be honoured falls back to a fresh shell.
  // Guarded so a shell that keeps failing to spawn can't loop.
  const respawnedRef = useRef(false);

  const connection = useTerminalWebSocket({
    featureId: props.featureId,
    projectId: props.projectId,
    shouldKillOnUnmount: () => refs.shouldKillRef.current,
    ptyId: props.existingPtyId,
    requestedCwd: props.requestedCwd,
    onData: (data) => {
      if (!refs.mountedRef.current) return;
      bridge.deliverData(data);
    },
    onReady: (ptyId, cwd) => {
      if (!refs.mountedRef.current) {
        connection.kill();
        return;
      }
      setErrorMessage(null);
      refs.ptyIdRef.current = ptyId;
      props.onPtyReady?.(ptyId, cwd);
      setPtyReady(true);
    },
    onExit: (code) => {
      if (!refs.mountedRef.current) return;
      bridge.deliverClose(`exited (${code})`);
      const id = refs.ptyIdRef.current;
      if (id) props.onExit?.(id);
    },
    // Returning to a pane whose PTY already exists answers `reconnected`,
    // never `ready` — so this is the only place that can mark such a pane
    // ready. Without it `ptyReady` stays false forever and the terminal is
    // never attached, which reads as the pane silently disappearing.
    onReconnected: (scrollback, alive, cwd) => {
      if (!refs.mountedRef.current) return;
      if (!alive) {
        respawnFresh();
        return;
      }
      setErrorMessage(null);
      bridge.deliverSnapshot(scrollback);
      const ptyId = refs.ptyIdRef.current;
      if (ptyId && cwd) props.onPtyReady?.(ptyId, cwd);
      setPtyReady(true);
    },
    onError: (message, kind) => {
      if (!refs.mountedRef.current) return;
      // Only a backend refusal means the PTY is unreachable ("PTY not found
      // for feature"); nothing else retries, since the connect effect runs
      // once. A dropped socket is not that — it already has a reconnect
      // scheduled, and respawning there would throw away a live shell.
      if (kind === "protocol" && !ptyReady && refs.ptyIdRef.current) {
        respawnFresh();
        return;
      }
      setErrorMessage(message);
    },
  });

  const bridge = useCelerittyTransport(connection);

  // Declared after `connection` so it can drive it; only ever called from the
  // socket callbacks above, which run long after this binding is initialized
  // (same shape as `bridge`'s use in `onData`).
  function respawnFresh(): void {
    if (respawnedRef.current) return;
    respawnedRef.current = true;
    refs.ptyIdRef.current = null;
    bridge.deliverSnapshot("");
    connection.forgetPty();
    connection.connect(INITIAL_COLUMNS, INITIAL_ROWS);
  }

  // Ctrl-arm interception lives here, on the outbound (write) side — not on
  // useTerminalWebSocket's `onData`, which is PTY output arriving, the wrong
  // direction. `Terminal.attach()` already forwards every keystroke to
  // `transport.write()` automatically; wrapping `write` is the one hook point
  // that doesn't also require subscribing to the terminal's own "data" event
  // a second time, which would send every keystroke twice.
  const transport = useMemo<TerminalTransport>(
    () => ({
      ...bridge.transport,
      write(bytes: Uint8Array) {
        if (refs.ctrlArmedRef.current) {
          const text = new TextDecoder().decode(bytes);
          const control = toControlChar(text);
          refs.onConsumeCtrlRef.current?.();
          bridge.transport.write(new TextEncoder().encode(control ?? text));
          return;
        }
        bridge.transport.write(bytes);
      },
    }),
    [bridge, refs.ctrlArmedRef, refs.onConsumeCtrlRef],
  );

  return { connection, transport, ptyReady, errorMessage };
}

/**
 * Routes `link-activate`/`link-hover` through `LinkRoutingContext` — the
 * same policy (internal vs. default browser, native context-menu hover
 * state) `XTermInstance` fed via `@xterm/addon-web-links`. `celeritty`
 * only detects and reports; it never opens a link itself.
 *
 * Split out to stay under the 100-line function budget.
 */
function useLinkRoutingWiring(terminal: Terminal | undefined): void {
  const linkRouting = useLinkRouting();
  const linkRoutingRef = useRef(linkRouting);
  linkRoutingRef.current = linkRouting;

  useEffect(() => {
    if (!terminal) return;
    const offActivate = terminal.on("link-activate", ({ url, modifiers }) => {
      // Matches XTermInstance's WebLinksAddon gating: a plain click is a
      // click, not an "open this" — only Cmd/Ctrl+Click activates.
      if (modifiers.meta || modifiers.ctrl) linkRoutingRef.current?.activate(url);
    });
    const offHover = terminal.on("link-hover", (url) => {
      linkRoutingRef.current?.setHoverLink(url);
    });
    return () => {
      offActivate();
      offHover();
      linkRoutingRef.current?.setHoverLink(null);
    };
  }, [terminal]);
}

/**
 * Flushes the initial notice (local write) and command (sent through the
 * transport) once both the PTY and terminal are ready. Split out purely to
 * stay under the 100-line function budget.
 */
function useInitialNoticeAndCommand(
  terminal: Terminal | undefined,
  ptyReady: boolean,
  connection: ShellSocket["connection"],
  refs: CoreRefs,
): void {
  useEffect(() => {
    if (!terminal || !ptyReady || !connection.isConnected) return;

    const notice = refs.initialNoticeRef.current;
    if (notice && !refs.noticeConsumedRef.current) {
      refs.noticeConsumedRef.current = true;
      terminal.write(`\x1b[90m→ cd ${notice}\x1b[0m\r\n`);
      refs.onInitialNoticeConsumedRef.current?.();
    }

    const command = refs.initialCommandRef.current;
    if (command && !refs.commandConsumedRef.current) {
      const timer = setTimeout(() => {
        if (!refs.mountedRef.current) return;
        if (!connection.write(command)) return;
        refs.commandConsumedRef.current = true;
        refs.onInitialCommandConsumedRef.current?.();
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [terminal, ptyReady, connection, refs]);
}

export function useTerminalCoreInstanceController(
  props: TerminalCoreInstanceProps,
  ref: ForwardedRef<TerminalCoreInstanceHandle>,
) {
  const refs = useCoreRefs(props);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { options, isLoading, error } = useTerminalOptions({
    palette: props.theme,
    fontFamily: props.fontFamily,
  });
  const {
    connection,
    transport,
    ptyReady,
    errorMessage: socketError,
  } = useShellSocket(props, refs);

  const { terminal, status, errorMessage } = useCelerittyTerminal({
    hostRef,
    options,
    // Held back until PTY spawned: `Terminal.attach()` sends the real grid
    // immediately; passing undefined prevents drops on a closed socket.
    transport: ptyReady ? transport : undefined,
  });

  useEffect(() => {
    if (status === "error") connection.disconnect();
  }, [status, connection.disconnect]);

  useLinkRoutingWiring(terminal);

  // Touch scrolling and the Cmd+arrow line-navigation keys were provided by
  // xterm.js addons; celeritty has neither (no touch handling at all, and it
  // drops Meta-held keys by design). Both are ported rather than dropped —
  // see each module for what carried over and what did not.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !terminal) return;
    const detachTouch = attachTouchScroll(host, terminal);
    const detachKeys = attachNavigationKeys(host, {
      isActive: () => refs.ptyIdRef.current !== null,
      write: (data) => connection.write(data),
    });
    return () => {
      detachTouch();
      detachKeys();
    };
  }, [terminal, connection, refs]);

  // Spawn once valid options are available. `Terminal.attach()`
  // corrects it to the real measured grid as soon as it attaches.
  useEffect(() => {
    if (!options) return;
    connection.connect(INITIAL_COLUMNS, INITIAL_ROWS);
    return () => {
      connection.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.connect, connection.disconnect, options === undefined]);

  // Both the canvas host and nested IME/fallback inputs must identify the
  // focused split pane to TerminalPortals.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onFocus = (): void => refs.onTerminalFocusRef.current?.();
    host.addEventListener("focusin", onFocus);
    return () => host.removeEventListener("focusin", onFocus);
  }, [refs]);

  useInitialNoticeAndCommand(terminal, ptyReady, connection, refs);

  const handleRef = useRef<TerminalCoreInstanceHandle | null>(null);
  const setHandle = useCallback(
    (t: typeof terminal) => {
      handleRef.current = {
        focus: () => t?.focus(),
        clearScreen: () => t?.clearScreen(),
        clearInput: () => connection.write("\x15"),
        blur: () => t?.blur(),
        markForKill: () => (refs.shouldKillRef.current = true),
        write: (data: string) => t?.write(data),
        getSelection: () => t?.getSelection() ?? null,
        paste: (text: string) => connection.write(text),
      };
    },
    [connection, refs],
  );

  useEffect(() => {
    setHandle(terminal);
    if (ref && typeof ref !== "function") {
      (ref as MutableRefObject<TerminalCoreInstanceHandle | null>).current = handleRef.current;
    } else if (typeof ref === "function") {
      ref(handleRef.current);
    }
  }, [terminal, ref, setHandle]);

  useEffect(() => {
    // Re-armed on every (re)mount, not just at first ref creation: `refs` is
    // deliberately stable across remounts (`useCoreRefs`), so a flag that is
    // only ever cleared stays cleared. StrictMode's mount → cleanup → remount
    // used to leave this `false` forever, which made `onReady` kill the very
    // PTY it had just spawned.
    refs.mountedRef.current = true;
    return () => {
      refs.mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo(
    () => ({
      hostRef,
      status: error || socketError ? ("error" as const) : status,
      isLoading,
      error: error ?? errorMessage ?? socketError,
    }),
    [status, isLoading, error, errorMessage, socketError],
  );
}
