import { create } from "zustand";

/**
 * The single full-screen visualization (`vega-lite` chart or `cadencr-html`
 * visual), owned globally for the same reason as `mermaid-fullscreen-store`
 * and `image-lightbox-store`: stream rows are virtualized, so a dialog
 * portalled from inside a message dies when Virtuoso recycles that row. Only
 * `VisualFullscreenHost` subscribes.
 */
export type FullscreenVisual =
  | { kind: "vega-lite"; code: string }
  | { kind: "cadencr-html"; code: string };

interface VisualFullscreenState {
  visual: FullscreenVisual | null;
  close: () => void;
}

export const useVisualFullscreenStore = create<VisualFullscreenState>((set) => ({
  visual: null,
  close: () => set({ visual: null }),
}));

/** Open a visualization full screen from anywhere without subscribing to the store. */
export function openVisualFullscreen(visual: FullscreenVisual): void {
  useVisualFullscreenStore.setState({ visual });
}
