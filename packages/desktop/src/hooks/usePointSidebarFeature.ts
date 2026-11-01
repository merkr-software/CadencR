import { useCallback, useEffect } from "react";
import { useSidebarPointedFeatureStore } from "@/stores/sidebar-pointed-feature-store";

/** Lights the conversation up in the sidebar while the pointer or focus is on the caller. */
export function usePointSidebarFeature(featureId: number) {
  const point = useCallback(() => {
    useSidebarPointedFeatureStore.getState().setPointedFeature(featureId);
  }, [featureId]);
  const release = useCallback(() => {
    const store = useSidebarPointedFeatureStore.getState();
    if (store.pointedFeatureId === featureId) store.setPointedFeature(null);
  }, [featureId]);
  // The stream recycles rows: one can unmount under the pointer.
  useEffect(() => release, [release]);
  return { onMouseEnter: point, onMouseLeave: release, onFocus: point, onBlur: release };
}
