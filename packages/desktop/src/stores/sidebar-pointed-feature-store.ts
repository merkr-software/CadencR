import { create } from "zustand";

interface SidebarPointedFeatureState {
  /** A conversation pointed at from outside the sidebar: its rows light up. */
  pointedFeatureId: number | null;
  setPointedFeature: (featureId: number | null) => void;
}

export const useSidebarPointedFeatureStore = create<SidebarPointedFeatureState>((set) => ({
  pointedFeatureId: null,
  setPointedFeature: (featureId) =>
    set((state) =>
      state.pointedFeatureId === featureId ? state : { pointedFeatureId: featureId },
    ),
}));

/** Whether this conversation's sidebar rows should light up. */
export function useIsSidebarPointedFeature(featureId: number): boolean {
  return useSidebarPointedFeatureStore((state) => state.pointedFeatureId === featureId);
}
