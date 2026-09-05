import { useEffect, useRef, useState } from "react";
import { Terminal, type TerminalOptions, type TerminalTransport } from "celeritty";

export interface UseCelerittyTerminalOptions {
  hostRef: React.RefObject<HTMLElement | null>;
  options: TerminalOptions | undefined;
  transport: TerminalTransport | undefined;
}

export interface UseCelerittyTerminalResult {
  terminal: Terminal | undefined;
  status: "loading" | "ready" | "error";
  errorMessage: string | null;
}

/**
 * Owns one `celeritty` `Terminal`'s lifecycle: construct once options and
 * a host are available, attach/detach as the transport comes and goes,
 * dispose on unmount. Shared between the shell panel and the Neovim pane —
 * each keeps its own socket hook and its own `TerminalTransport` adapter;
 * this hook knows about neither.
 */
export function useCelerittyTerminal(o: UseCelerittyTerminalOptions): UseCelerittyTerminalResult {
  const { hostRef, options, transport } = o;
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);

  // Constructed once options and the host are both available. Not keyed on
  // `options` identity — a live config change goes through `setOptions` in
  // the effect below, not through rebuilding the terminal.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !options) return;

    let cancelled = false;
    const terminal = new Terminal(host, options);
    terminalRef.current = terminal;

    terminal.ready
      .then(() => {
        if (cancelled) return;
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : "WebGPU is not available");
        setStatus("error");
      });

    return () => {
      cancelled = true;
      terminal.dispose();
      terminalRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostRef.current, options === undefined]);

  // Live theme/font/scrollback changes: patched in place, no rebuild.
  useEffect(() => {
    if (!options) return;
    terminalRef.current?.setOptions(options);
  }, [options]);

  // Attach/detach as the transport comes and goes. Waits for `ready` so a
  // transport arriving before the engine has finished loading doesn't attach
  // to a terminal that can't `feed()` yet.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !transport) return;

    let cancelled = false;
    terminal.ready.then(() => {
      if (cancelled) return;
      terminal.attach(transport);
    });

    return () => {
      cancelled = true;
      terminal.detach();
    };
  }, [transport, status]);

  return {
    terminal: terminalRef.current,
    status,
    errorMessage,
  };
}
