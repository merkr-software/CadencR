import { translateUi } from "@/lib/i18n/ui";
import { useEffect, useRef, useState } from "react";
import type { TerminalOptions, TerminalTransport } from "celeritty";
import { toast } from "sonner";
import { createTerminalEngine } from "./create-terminal-engine";
import type { TerminalEngine } from "./terminal-engine";

export interface UseCelerittyTerminalOptions {
  hostRef: React.RefObject<HTMLElement | null>;
  options: TerminalOptions | undefined;
  transport: TerminalTransport | undefined;
}
export interface UseCelerittyTerminalResult {
  terminal: TerminalEngine | undefined;
  status: "loading" | "ready" | "error";
  errorMessage: string | null;
}
const LOADING: UseCelerittyTerminalResult = {
  terminal: undefined,
  status: "loading",
  errorMessage: null,
};

/** Own the renderer independently of the socket and live option identities. */
export function useCelerittyTerminal({
  hostRef,
  options,
  transport,
}: UseCelerittyTerminalOptions): UseCelerittyTerminalResult {
  const [state, setState] = useState<UseCelerittyTerminalResult>(LOADING);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const hasOptions = options !== undefined;

  useEffect(() => {
    const host = hostRef.current;
    const initialOptions = optionsRef.current;
    setState(LOADING);
    if (!host || !initialOptions) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeDiagnostic: (() => void) | undefined;
    const lifecycle = createTerminalEngine(host, initialOptions);
    const fail = (error: unknown): void => {
      if (cancelled) return;
      setState({
        terminal: undefined,
        status: "error",
        errorMessage:
          error instanceof Error
            ? error.message
            : translateUi(
                "workspace.tools.useCelerittyTerminal.terminalInitializationFailed",
                "Terminal initialization failed",
              ),
      });
      // Dispose outside the event callback to avoid reentrant renderer teardown.
      queueMicrotask(lifecycle.dispose);
    };
    void lifecycle.ready
      .then((instance) => {
        if (cancelled || !instance) return;
        unsubscribe = instance.on("error", fail);
        unsubscribeDiagnostic = instance.on("diagnostic", (error) => {
          toast.warning(
            translateUi(
              "workspace.tools.useCelerittyTerminal.terminalRenderingWarning",
              "Terminal rendering warning",
            ),
            {
              id: "terminal-renderer-diagnostic",
              description: error.message,
            },
          );
        });
        setState({ terminal: instance, status: "ready", errorMessage: null });
      })
      .catch(fail);
    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeDiagnostic?.();
      lifecycle.dispose();
    };
  }, [hostRef, hasOptions]);

  useEffect(() => {
    if (options) state.terminal?.setOptions(options);
  }, [options, state.terminal]);

  useEffect(() => {
    if (!state.terminal || !transport) return;
    state.terminal.attach(transport);
    return () => state.terminal?.detach();
  }, [transport, state.terminal]);

  return state;
}
