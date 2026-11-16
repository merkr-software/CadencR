import { create } from "zustand";

interface SidebarLensState {
  /** Lens groups folded from their header, by group key; all start open. */
  folded: ReadonlySet<string>;
  toggleGroup: (key: string) => void;
}

/** In memory: folds outlive the list (the preview swaps it out) but not a reload. */
export const useSidebarLensStore = create<SidebarLensState>((set) => ({
  folded: new Set(),
  toggleGroup: (key) =>
    set((state) => {
      const folded = new Set(state.folded);
      if (folded.has(key)) folded.delete(key);
      else folded.add(key);
      return { folded };
    }),
}));
