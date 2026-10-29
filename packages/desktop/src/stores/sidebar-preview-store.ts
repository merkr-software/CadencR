import { create } from "zustand";
import type { SidebarOptionId, SidebarSectionId } from "@/lib/sidebar-config";

/** The header button that opened the display options. */
export interface SidebarOptionsOrigin {
  /**
   * Where it stood then: the popover opens level with it, and stays put while
   * the sidebar swaps in the samples.
   */
  anchor: DOMRect;
  /** Its section, whose button takes the focus back on Escape. */
  section: SidebarSectionId;
}

interface SidebarPreviewState {
  /** The display options popover is open: the sidebar shows sample conversations. */
  optionsOpen: boolean;
  /** Where the options were opened from; null while closed. */
  optionsOrigin: SidebarOptionsOrigin | null;
  /** Asked for the real conversations instead, until the app restarts. */
  showMine: boolean;
  /** The option under the pointer or focus in the display options: the sidebar outlines what it changes. */
  highlight: SidebarOptionId | null;
  openOptions: (origin: SidebarOptionsOrigin) => void;
  closeOptions: () => void;
  setShowMine: (showMine: boolean) => void;
  setHighlight: (option: SidebarOptionId | null) => void;
}

export const useSidebarPreviewStore = create<SidebarPreviewState>((set) => ({
  optionsOpen: false,
  optionsOrigin: null,
  showMine: false,
  highlight: null,
  openOptions: (optionsOrigin) => set({ optionsOpen: true, optionsOrigin }),
  closeOptions: () => set({ optionsOpen: false, optionsOrigin: null, highlight: null }),
  setShowMine: (showMine) => set({ showMine }),
  setHighlight: (highlight) =>
    set((state) => (state.highlight === highlight ? state : { highlight })),
}));

/** Whether the sidebar shows the sample conversations in place of the real ones. */
export function useSidebarShowsSamples(): boolean {
  return useSidebarPreviewStore((state) => state.optionsOpen && !state.showMine);
}
