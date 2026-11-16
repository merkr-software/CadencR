import { create } from "zustand";

/** The sidebar row typing started from, by nav identity (it may unmount while filtering). */
export interface FilterOrigin {
  navType: string;
  navId: string;
}

interface SidebarFilterState {
  /** Whether the filter field is showing (it stays open while empty and focused). */
  isOpen: boolean;
  /** The sidebar's local filter; empty when it is not filtering. */
  query: string;
  origin: FilterOrigin | null;
  /** Bumped on every typed key so the field takes focus back from a result row. */
  focusRequest: number;
  /**
   * Opens the field with the first typed character, or appends to the open
   * filter (typing from a result row) while keeping where typing first began.
   */
  start: (key: string, origin?: FilterOrigin | null) => void;
  setQuery: (query: string) => void;
  close: () => void;
}

/** Session-local: a filter is a moment's search, never restored on reload. */
export const useSidebarFilterStore = create<SidebarFilterState>((set) => ({
  isOpen: false,
  query: "",
  origin: null,
  focusRequest: 0,
  start: (key, origin = null) =>
    set((state) =>
      state.isOpen
        ? { query: state.query + key, focusRequest: state.focusRequest + 1 }
        : { isOpen: true, query: key, origin, focusRequest: state.focusRequest + 1 },
    ),
  setQuery: (query) => set({ query }),
  close: () => set({ isOpen: false, query: "", origin: null }),
}));

/** The active filter, trimmed; empty means show everything. */
export function useSidebarFilterQuery(): string {
  return useSidebarFilterStore((state) => state.query.trim());
}
