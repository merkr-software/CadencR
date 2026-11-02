import { createContext } from "react";
import { create } from "zustand";

/**
 * Where a sidebar row is rendered: the project tree (and Pinned), "For me",
 * "In progress", "Recent", the rail.
 */
export type SidebarSurface = "tree" | "for-me" | "working" | "recent" | "rail";

/** The conversation blocks above the project list that are surfaces of their own. */
export type SidebarBlockSurface = Extract<SidebarSurface, "for-me" | "working" | "recent">;

/** Every block besides the project list; Pinned's rows belong to the tree's surface. */
export type SidebarBlockId = SidebarBlockSurface | "pinned";

interface SidebarSurfaceState {
  /** For me's "Show more": every action shows, past the "For me shows" limit. */
  forMeShowAll: boolean;
  toggleForMeShowAll: () => void;
}

export const useSidebarSurfaceStore = create<SidebarSurfaceState>((set) => ({
  forMeShowAll: false,
  toggleForMeShowAll: () => set((state) => ({ forMeShowAll: !state.forMeShowAll })),
}));

export const SidebarSurfaceContext = createContext<SidebarSurface>("tree");

/** While the sidebar is open: For me's rows when it is shown and unfolded, else the tree's. */
export function openSidebarGateOwner(forMeShown: boolean, filtering: boolean): SidebarSurface {
  return forMeShown && !filtering ? "for-me" : "tree";
}
