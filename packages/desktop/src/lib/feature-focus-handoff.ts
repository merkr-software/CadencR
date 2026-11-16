import type { Feature } from "@/api/generated";
import { type TabKind } from "@/stores/feature-layout-schema";
import { getFocusedTab, useFeatureLayoutStore } from "@/stores/feature-layout-store";

export function getFocusedTabForFeature(featureId: number | null): TabKind | undefined {
  if (featureId == null) return undefined;
  const state = useFeatureLayoutStore.getState().features[featureId];
  if (!state) return undefined;
  return getFocusedTab(state) ?? undefined;
}

export interface FeatureNavigateOptions {
  /** Open on this tab rather than on the one focused in the conversation being left. */
  focusTab?: TabKind;
}

/** Opens a conversation from the sidebar. */
export type FeatureNavigate = (feature: Feature, options?: FeatureNavigateOptions) => void;
