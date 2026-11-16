import { create } from "zustand";

interface SidebarRenameState {
  /** The conversation whose rename dialog is open, if any. */
  featureId: number | null;
  open: (featureId: number) => void;
  close: () => void;
}

/** One rename dialog for the whole sidebar, opened from a row's menu or F2. */
export const useSidebarRenameStore = create<SidebarRenameState>((set) => ({
  featureId: null,
  open: (featureId) => set({ featureId }),
  close: () => set({ featureId: null }),
}));
