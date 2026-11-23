import { useEffect } from "react";

import { useGetFeatureSettings, useListLayouts } from "@/api/generated";
import { hydrateFeatureLayout } from "@/lib/feature-layout-hydration";
import { selectFeatureLayout, useFeatureLayoutStore } from "@/stores/feature-layout-store";

/**
 * One-shot hydrate of the in-memory `useFeatureLayoutStore` for a feature.
 *
 * The current per-feature layout is persisted in `feature_settings` under
 * `layout_state`. Named rows in `feature_layouts` remain explicit templates.
 * See `hydrateFeatureLayout` for the bootstrap order.
 *
 * Opening a conversation hydrates the same way before the workspace mounts
 * when its settings are already in memory (`hydratePreloadedConversation`), so
 * this effect only does the work for a feature opened without a preload.
 */
export function useFeatureLayoutHydration(
  featureId: number,
  options: { enabled?: boolean } = {},
): void {
  const enabled = options.enabled ?? true;
  const layoutsQuery = useListLayouts({ query: { enabled } });
  const settingsQuery = useGetFeatureSettings(featureId, { query: { enabled } });

  useEffect(() => {
    if (!enabled || layoutsQuery.isLoading || settingsQuery.isLoading) return;
    hydrateFeatureLayout(featureId, settingsQuery.data ?? [], layoutsQuery.data ?? []);
  }, [
    enabled,
    featureId,
    layoutsQuery.isLoading,
    layoutsQuery.data,
    settingsQuery.isLoading,
    settingsQuery.data,
  ]);
}

/** Read-only selector hook — wraps the store with the right featureId. */
export function useFeatureLayoutState(featureId: number) {
  return useFeatureLayoutStore(selectFeatureLayout(featureId));
}
