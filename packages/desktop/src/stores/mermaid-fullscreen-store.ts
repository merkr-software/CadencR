import { create } from "zustand";

/**
 * The single full-screen diagram, owned globally for the same reason as
 * `image-lightbox-store`: stream rows are virtualized, so a dialog portalled
 * from inside a message dies when Virtuoso recycles that row. Only
 * `MermaidFullscreenHost` subscribes.
 */
interface MermaidFullscreenState {
  /** The SVG on screen, or `null` when closed. Its ids must not collide with the inline copy. */
  svg: string | null;
  close: () => void;
}

export const useMermaidFullscreenStore = create<MermaidFullscreenState>((set) => ({
  svg: null,
  close: () => set({ svg: null }),
}));

/** Open a diagram full screen from anywhere without subscribing to the store. */
export function openMermaidFullscreen(svg: string): void {
  useMermaidFullscreenStore.setState({ svg });
}
