import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useTerminalWebSocket } from "@/hooks/useTerminalWebSocket";
import { isResizing, subscribeResize } from "@/lib/resize-coordinator";
import { toControlChar } from "@/lib/terminal-keys";
import type { XTermPalette } from "@/lib/themes";
import { createXtermInstance } from "./createXtermInstance";
import { attachXtermNavigationKeys } from "./xtermNavigationKeys";

interface XTermInstanceProps {
  featureId: number;
  projectId: number;
  /** Existing PTY ID to reconnect to (from zustand store) */
  existingPtyId?: string;
  /** Working directory hint forwarded to the backend on a fresh PTY request. */
  requestedCwd?: string;
  /** Active theme's xterm palette — applied at mount and live-swapped when
   *  the user picks a new theme. Canvas-rendered xterm can't read CSS vars,
   *  so this has to flow through props. */
  theme: XTermPalette;
  /** Called when the PTY process exits (e.g. Ctrl+D) */
  onExit?: (ptyId: string) => void;
  /**
   * Called after a PTY is created or reconnected — parent stores the ptyId
   * and (when known) the working directory the PTY was spawned in. `cwd` is
   * null on reconnect when the backend handle has been garbage-collected.
   */
  onPtyReady?: (ptyId: string, cwd: string | null) => void;
  /** If true, kill the PTY when unmounting (explicit close). Default: false (detach only). */
  killOnUnmount?: boolean;
  /** Command to write to the PTY after creation (does NOT press Enter — command includes \n if needed) */
  initialCommand?: string;
  /** Called after the initial command has been written so the parent can clear it from state */
  onInitialCommandConsumed?: () => void;
  /** Called when the terminal receives focus */
  onTerminalFocus?: () => void;
  /**
   * When true, the next character typed (e.g. from the mobile key bar's sticky
   * Ctrl) is converted to its control byte before being sent to the PTY.
   */
  ctrlArmed?: boolean;
  /** Called once an armed Ctrl modifier has been applied, so it can disarm. */
  onConsumeCtrl?: () => void;
}

export interface XTermInstanceHandle {
  /** Focus this terminal instance */
  focus: () => void;
  /** Clear the terminal viewport without deleting scrollback history */
  clearScreen: () => void;
  /** Delete the whole current shell input line without clearing terminal history */
  clearInput: () => void;
  /** Blur this terminal instance and stop cursor blink */
  blur: () => void;
  /** Mark this instance for PTY kill on next unmount */
  markForKill: () => void;
  /** Send a raw byte sequence to the PTY (e.g. Esc/Tab/arrows from the key bar). */
  write: (data: string) => void;
}

export const XTermInstance = forwardRef<XTermInstanceHandle, XTermInstanceProps>(
  function XTermInstance(
    {
      featureId,
      projectId,
      existingPtyId,
      requestedCwd,
      theme,
      onExit,
      onPtyReady,
      killOnUnmount = false,
      initialCommand,
      onInitialCommandConsumed,
      onTerminalFocus,
      ctrlArmed,
      onConsumeCtrl,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const ptyIdRef = useRef<string | null>(existingPtyId ?? null);
    const mountedRef = useRef(true);
    const exitedRef = useRef(false);
    const shouldKillRef = useRef(killOnUnmount);
    // True once `terminal.open(container)` has run and focus can reach a real
    // textarea. Earlier focus requests are replayed at the end of `ensureOpen()`.
    const openedRef = useRef(false);
    const pendingFocusRef = useRef(false);

    shouldKillRef.current = killOnUnmount;
    const onTerminalFocusRef = useRef(onTerminalFocus);
    onTerminalFocusRef.current = onTerminalFocus;
    const initialCommandRef = useRef(initialCommand);
    initialCommandRef.current = initialCommand;
    const onInitialCommandConsumedRef = useRef(onInitialCommandConsumed);
    onInitialCommandConsumedRef.current = onInitialCommandConsumed;
    // Read inside the (once-bound) onData handler without re-running its effect.
    const ctrlArmedRef = useRef(false);
    ctrlArmedRef.current = ctrlArmed ?? false;
    const onConsumeCtrlRef = useRef(onConsumeCtrl);
    onConsumeCtrlRef.current = onConsumeCtrl;

    useImperativeHandle(ref, () => ({
      focus: () => {
        const term = terminalRef.current;
        if (!term) return;
        term.options.cursorBlink = true;
        if (!openedRef.current) {
          // xterm isn't opened yet — there's no textarea to focus. Remember
          // the request and replay it from `ensureOpen()` once `terminal.open`
          // has run. Without this, post-create focus calls (CMD+T, post-split)
          // silently no-op because the dimensions race wins.
          pendingFocusRef.current = true;
          return;
        }
        term.focus();
      },
      clearScreen: () => {
        writeRef.current?.("\x0c");
      },
      clearInput: () => {
        writeRef.current?.("\x05\x15");
      },
      blur: () => {
        const term = terminalRef.current;
        if (!term) return;
        term.options.cursorBlink = false;
        // Clear any pending focus so a blur after a deferred focus actually
        // sticks instead of being overridden when the terminal finally opens.
        pendingFocusRef.current = false;
        term.blur();
      },
      markForKill: () => {
        shouldKillRef.current = true;
      },
      write: (data: string) => {
        if (ptyIdRef.current && !exitedRef.current) writeRef.current?.(data);
      },
    }));

    // Stable refs for ws actions so callbacks don't need to re-subscribe
    const writeRef = useRef<((data: string) => void) | null>(null);
    const resizeRef = useRef<((cols: number, rows: number) => void) | null>(null);
    const killRef = useRef<(() => void) | null>(null);
    const connectRef = useRef<((cols: number, rows: number) => void) | null>(null);

    // -- WebSocket callbacks (stable refs to avoid re-connecting) --

    const onWsData = useCallback((data: string) => {
      if (mountedRef.current) terminalRef.current?.write(data);
    }, []);

    const onWsReady = useCallback(
      (ptyId: string, cwd: string) => {
        if (!mountedRef.current) {
          // Unmounted before ready — kill via ws
          killRef.current?.();
          return;
        }
        ptyIdRef.current = ptyId;
        onPtyReady?.(ptyId, cwd);
        // Write initial command if provided
        const cmd = initialCommandRef.current;
        if (cmd) {
          setTimeout(() => {
            if (mountedRef.current && ptyIdRef.current) {
              writeRef.current?.(cmd);
            }
            onInitialCommandConsumedRef.current?.();
          }, 150);
        }
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    const onWsExit = useCallback(
      (code: number) => {
        if (!mountedRef.current) return;
        exitedRef.current = true;
        const id = ptyIdRef.current;
        terminalRef.current?.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
        if (id) onExit?.(id);
      },
      [onExit],
    );

    const onWsReconnected = useCallback(
      (scrollback: string, alive: boolean, cwd: string | null) => {
        if (!mountedRef.current) return;
        if (!alive) {
          exitedRef.current = true;
          terminalRef.current?.write("\r\n\x1b[90m[Terminal session ended]\x1b[0m\r\n");
          const id = ptyIdRef.current;
          if (id) onExit?.(id);
          return;
        }
        const id = ptyIdRef.current;
        if (id) onPtyReady?.(id, cwd);
        // Visible "we recovered" marker before re-applying scrollback so the
        // user sees that the prior "Connection lost. Reconnecting…" line
        // produced a successful reattach rather than a silent comeback.
        terminalRef.current?.write("\r\n\x1b[32m[Terminal reconnected]\x1b[0m\r\n");
        if (scrollback) terminalRef.current?.write(scrollback);
        // Sync size after reconnect
        try {
          fitAddonRef.current?.fit();
          const term = terminalRef.current;
          if (term) resizeRef.current?.(term.cols, term.rows);
        } catch {
          // Ignore resize errors
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      [onExit],
    );

    const onWsError = useCallback((message: string) => {
      if (!mountedRef.current) return;
      terminalRef.current?.write(`\r\n\x1b[31m[${message}]\x1b[0m\r\n`);
    }, []);

    const { connect, write, resize, kill } = useTerminalWebSocket({
      featureId: existingPtyId ? undefined : featureId,
      projectId: existingPtyId ? undefined : projectId,
      ptyId: existingPtyId,
      requestedCwd,
      onData: onWsData,
      onReady: onWsReady,
      onExit: onWsExit,
      onReconnected: onWsReconnected,
      onError: onWsError,
    });

    writeRef.current = write;
    resizeRef.current = resize;
    killRef.current = kill;
    connectRef.current = connect;

    useEffect(() => {
      mountedRef.current = true;
      exitedRef.current = false;
      const container = containerRef.current;
      if (!container) return;

      // The mount effect intentionally doesn't depend on `theme` (re-mounting
      // would lose scrollback). Subsequent palette changes flow through the
      // live-swap effect below, which mutates `terminal.options.theme`.
      const terminal = createXtermInstance(theme);
      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);

      // macOS-style navigation: Cmd+Arrow (line) and Option+Arrow (word).
      // Safe to attach pre-`open()` — handler only fires once a textarea exists.
      //
      // The modifier check must be *exclusive*: CMD+OPT+Arrow is the split-
      // navigation chord owned by TerminalPanel, not a line/word jump. If we
      // only checked `metaKey ? "meta" : altKey ? "alt"`, the meta branch
      // would win on CMD+OPT+ArrowLeft and we'd ship \x01 (Ctrl+A) to the
      // pane the user is *leaving*, which the user reported as "arrows do
      // nothing visible to the splits".
      attachXtermNavigationKeys(terminal, { exitedRef, ptyIdRef, writeRef });

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // We defer `terminal.open(container)` until the container actually has
      // pixel dimensions. xterm.js opened in a `display:none` parent
      // initializes its renderer in a degraded 0×0 state and never recovers
      // cleanly even after `fit()` — the textarea ends up unfocusable and
      // the screen stays blank. With the new layout system, tab content is
      // always mounted (even when its tab isn't the active one in its
      // pane), so the container starts hidden whenever the user opens a
      // session in another tab. The single ResizeObserver below is the one
      // signal we need: when it sees a non-zero rect we can open xterm,
      // wire up data + focus listeners, run a fit, and connect the WS — in
      // that order.
      let opened = false;
      let connected = false;
      let dataDisposable: { dispose: () => void } | null = null;
      let onFocusHandler: (() => void) | null = null;
      let touchScrollCleanup: (() => void) | null = null;

      const ensureOpen = (): boolean => {
        if (opened) return true;
        if (container.offsetWidth === 0 || container.offsetHeight === 0) return false;
        terminal.open(container);
        onFocusHandler = (): void => onTerminalFocusRef.current?.();
        terminal.textarea?.addEventListener("focus", onFocusHandler);
        dataDisposable = terminal.onData((data: string) => {
          if (!ptyIdRef.current || exitedRef.current) return;
          if (ctrlArmedRef.current) {
            // Sticky Ctrl from the mobile key bar: fold it into this keystroke.
            const ctrl = toControlChar(data);
            onConsumeCtrlRef.current?.();
            writeRef.current?.(ctrl ?? data);
            return;
          }
          writeRef.current?.(data);
        });
        // iOS hands xterm no usable scroll gesture, so we drive scrolling from
        // touch deltas. Bind to the container we own, NOT `.xterm-viewport`:
        // the viewport is `position:absolute` and xterm's `.xterm-screen`
        // (plus the scrollbar overlay) paint on top of it, so touches never
        // reach a viewport-bound listener — but they DO bubble up to here. A
        // tap (no move) is left alone, so tapping to focus still opens the
        // keyboard.
        touchScrollCleanup = attachTouchScroll(container, terminal);
        opened = true;
        openedRef.current = true;
        // Replay focus requested before the textarea existed.
        if (pendingFocusRef.current) {
          pendingFocusRef.current = false;
          terminal.focus();
        }
        return true;
      };

      const runFit = (): boolean => {
        if (!mountedRef.current || exitedRef.current) return false;
        if (!ensureOpen()) return false;
        try {
          fitAddon.fit();
        } catch {
          return false;
        }
        if (!connected) {
          connected = true;
          connectRef.current?.(terminal.cols, terminal.rows);
        } else {
          const id = ptyIdRef.current;
          if (id) resizeRef.current?.(terminal.cols, terminal.rows);
        }
        return true;
      };

      const resizeObserver = new ResizeObserver((entries) => {
        if (!mountedRef.current || exitedRef.current) return;
        // Skip when container is hidden (display:none) — fitting with 0 dimensions
        // causes xterm.js to reflow the buffer and drop lines irreversibly.
        const entry = entries[0];
        if (entry && entry.contentRect.width === 0 && entry.contentRect.height === 0) return;
        // Defer fit while the user is actively dragging a resize handle.
        // `fitAddon.fit()` measures the cell metrics off the DOM and reflows
        // xterm's buffer; running it per frame for every visible terminal pane
        // during a drag is one of the dominant cascading-RO costs we want to
        // avoid. We catch up with a single `fit()` once the drag ends. The
        // very first fit (pre-`connected`) must still run so the PTY can
        // boot at correct dimensions.
        if (connected && isResizing()) return;
        runFit();
      });
      resizeObserver.observe(container);

      // Catch-up fit on resize-end so the terminal lands at the final size.
      const unsubscribeResize = subscribeResize((active) => {
        if (active) return;
        runFit();
      });

      // Visibility signal. `ResizeObserver` is known to silently skip
      // `display:none` → `display:block` transitions in some Chromium
      // versions (crbug.com/899068) — the user clicks the Terminal tab,
      // we flip our tab-mount's display, but no RO callback ever fires,
      // so xterm never gets opened. `IntersectionObserver` is the right
      // tool here: it fires reliably the moment the element enters the
      // viewport, including when an ancestor flips from display:none.
      const intersectionObserver = new IntersectionObserver((entries) => {
        if (!mountedRef.current || exitedRef.current) return;
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        runFit();
      });
      intersectionObserver.observe(container);

      // Belt-and-braces rAF retry for layout edges missed by RO/IO.
      let bootstrapRaf = 0;
      const tryBootstrap = (): void => {
        if (opened || !mountedRef.current || exitedRef.current) return;
        if (runFit()) return;
        bootstrapRaf = requestAnimationFrame(tryBootstrap);
      };
      bootstrapRaf = requestAnimationFrame(tryBootstrap);

      return () => {
        mountedRef.current = false;
        cancelAnimationFrame(bootstrapRaf);
        intersectionObserver.disconnect();
        resizeObserver.disconnect();
        unsubscribeResize();
        if (onFocusHandler) terminal.textarea?.removeEventListener("focus", onFocusHandler);
        touchScrollCleanup?.();
        dataDisposable?.dispose();

        if (ptyIdRef.current && !exitedRef.current && shouldKillRef.current) {
          killRef.current?.();
        }
        ptyIdRef.current = null;
        openedRef.current = false;
        pendingFocusRef.current = false;
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [featureId, projectId]);

    // Live-swap the xterm palette on theme change. xterm short-circuits when
    // the same reference is reassigned, so we spread into a fresh literal,
    // then `refresh()` forces an immediate canvas redraw. The renderer can
    // only refresh once xterm has been opened against a sized container —
    // before that, options.theme is enough; the open() pass picks it up.
    useEffect(() => {
      const term = terminalRef.current;
      if (!term) return;
      term.options.theme = { ...theme };
      if (term.element) term.refresh(0, term.rows - 1);
    }, [theme]);

    return (
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{
          backgroundColor: "var(--terminal-bg)",
          paddingLeft: 8,
          paddingRight: 8,
        }}
      />
    );
  },
);

/**
 * Make the terminal draggable by finger on touch devices. xterm 6 drives
 * scrolling through VS Code's `ScrollableElement` (not a native CSS overflow
 * scroller), and iOS never feeds that element a touch gesture — so a finger
 * drag did nothing. We translate the vertical touch delta into whole-row
 * scrolls via xterm's public `scrollLines()` API, which is the same path the
 * wheel uses, so the buffer and scrollbar stay in sync. `surface` is the outer
 * container (not `.xterm-viewport`, which is painted over and never sees the
 * touches). Returns a cleanup fn; inert on non-touch input since touch events
 * never fire there.
 */
function attachTouchScroll(surface: HTMLElement, terminal: Terminal): () => void {
  let lastY = 0;
  // Sub-row pixels carried between moves so slow drags still scroll smoothly
  // instead of rounding every delta down to zero.
  let pixelRemainder = 0;
  // Row height in px, sampled once per drag at `touchstart`. Reading
  // `clientHeight` here (not on every `touchmove`) keeps a forced reflow off
  // the rapid-fire move path; the terminal can't resize mid-drag anyway.
  let rowHeight = 1;

  const onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) return;
    lastY = e.touches[0].clientY;
    pixelRemainder = 0;
    rowHeight = Math.max(1, surface.clientHeight / Math.max(1, terminal.rows));
  };

  const onTouchMove = (e: TouchEvent): void => {
    if (e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    pixelRemainder += y - lastY;
    lastY = y;
    const rows = Math.trunc(pixelRemainder / rowHeight);
    if (rows === 0) return;
    pixelRemainder -= rows * rowHeight;
    // Finger down (rows > 0) reveals older output, i.e. scroll up → negative.
    terminal.scrollLines(-rows);
    e.preventDefault();
  };

  surface.addEventListener("touchstart", onTouchStart, { passive: true });
  surface.addEventListener("touchmove", onTouchMove, { passive: false });
  return () => {
    surface.removeEventListener("touchstart", onTouchStart);
    surface.removeEventListener("touchmove", onTouchMove);
  };
}
