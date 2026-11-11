import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  getGetFeatureSettingsQueryKey,
  setFeatureSetting,
  type Feature,
  type FeatureSetting,
} from "@/api/generated";
import { GIT_VIEW_MODE_SETTING } from "@/components/diff/useGitTabViewState";
import { toastError } from "@/lib/api-errors";
import type { FeatureNavigate } from "@/lib/feature-focus-handoff";
import { showBuiltinTab } from "@/lib/plugin-tabs/builtin-fallback";
import { activateFeatureTab, useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { useViewedPrStore } from "@/stores/viewed-pr-store";

/**
 * Opens a conversation's pull request in its Git tab: the conversation, the
 * Git tab, its PR view, and that proposal among the conversation's (`null` for
 * the current branch's).
 *
 * The tab rides the navigation's `focusTab`, which waits for the layout to
 * hydrate; a conversation already open is switched directly, since navigating
 * to the URL it is already on requests nothing new. The view is a persisted
 * per-conversation setting, written like the tab strip writes it.
 */
export function useOpenFeaturePr(
  feature: Feature,
  onNavigate: FeatureNavigate,
): (prNumber: number | null) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (prNumber: number | null): void => {
      useViewedPrStore.getState().setViewedPr(feature.id, prNumber);
      // The pull request shows in the built-in Git tab, even where a custom tab replaces it.
      showBuiltinTab(feature.id, "git");
      // Only a hydrated layout: seeding one would shadow the saved layout.
      if (useFeatureLayoutStore.getState().features[feature.id]) {
        activateFeatureTab(feature.id, "git");
      }
      onNavigate(feature, { focusTab: "git" });
      const settingsKey = getGetFeatureSettingsQueryKey(feature.id);
      const viewMode = queryClient
        .getQueryData<FeatureSetting[]>(settingsKey)
        ?.find((setting) => setting.key === GIT_VIEW_MODE_SETTING)?.value;
      if (viewMode === "pr") return;
      setFeatureSetting(feature.id, { key: GIT_VIEW_MODE_SETTING, value: "pr" })
        .then(() => queryClient.invalidateQueries({ queryKey: settingsKey }))
        .catch((error: unknown) => toastError(error, "Could not open the pull request view."));
    },
    [feature, onNavigate, queryClient],
  );
}
