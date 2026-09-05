import { createWebGpuRenderer, Terminal, type TerminalOptions } from "celeritty";
import { toast } from "sonner";
import type { TerminalEngine } from "./terminal-engine";

/** Initialization is cancellable even while WASM, GPU or fallback chunks load. */
export function createTerminalEngine(host: HTMLElement, options: TerminalOptions) {
  let cancelled = false;
  let engine: TerminalEngine | undefined;
  const dispose = (): void => {
    const current = engine;
    engine = undefined;
    current?.dispose();
  };
  const ready = (async (): Promise<TerminalEngine | undefined> => {
    try {
      engine = new Terminal(host, options, async (canvas, atlas) => {
        const renderer = await createWebGpuRenderer(canvas, atlas);
        if (cancelled) {
          renderer.dispose();
          throw new Error("Terminal initialization cancelled");
        }
        return renderer;
      });
      await engine.ready;
      if (!cancelled) host.dataset.terminalRenderer = "celeritty";
    } catch (error) {
      if (cancelled) return undefined;
      dispose();
      const { XtermCompatibility } = await import("./xterm-compatibility");
      if (cancelled) return undefined;
      engine = new XtermCompatibility(host, options);
      await engine.ready;
      if (!cancelled) {
        host.dataset.terminalRenderer = "xterm";
        toast.warning("Using the compatibility terminal", {
          id: "terminal-compatibility",
          description: error instanceof Error ? error.message : "WebGPU initialization failed",
        });
      }
    }
    if (cancelled) {
      dispose();
      return undefined;
    }
    return engine;
  })();
  return {
    ready,
    dispose: () => {
      cancelled = true;
      dispose();
    },
  };
}
