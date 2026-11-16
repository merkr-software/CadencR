import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetFeatureSettingsQueryKey,
  useGetFeatureSettings,
  useSetFeatureSetting,
} from "@/api/generated";
import { useSetting } from "@/hooks/useSetting";
import { apiErrorMessage } from "@/lib/api-errors";
import type { GitViewMode } from "./GitTabToggle";

export const GIT_VIEW_MODE_SETTING = "git_view_mode";
const GIT_SIDEBAR_COLLAPSED_SETTING = "git_sidebar_collapsed";

export function isGitViewMode(value: string | undefined): value is GitViewMode {
  return (
    value === "uncommitted" ||
    value === "vs-target" ||
    value === "pr" ||
    value === "graph" ||
    value === "branches" ||
    value === "stashes"
  );
}

export interface GitTabViewState {
  viewMode: GitViewMode;
  setViewMode: (next: GitViewMode) => void;
  /**
   * The view whose save is still in flight, or `null`. Named rather than a bare
   * boolean so the strip can mark the one tab that is waiting instead of
   * disabling all six — a persisted preference must not make navigation feel
   * like it stopped responding.
   */
  pendingViewMode: GitViewMode | null;
  fileListCollapsed: boolean;
  setFileListCollapsed: (collapsed: boolean) => void;
  toggleFileList: () => void;
  isFileListCollapseLoading: boolean;
}

/**
 * The Git tab's two persisted preferences: which sub-view is open, and whether
 * the file list is collapsed.
 *
 * The local view-mode mirror advances only after the backend confirms the
 * mutation — the persisted query stays the reload and cross-tab source of
 * truth, so a failed save leaves the UI showing what is actually stored rather
 * than a view the user never got.
 */
export function useGitTabViewState(
  featureId: number,
  fallbackViewMode: GitViewMode,
): GitTabViewState {
  const queryClient = useQueryClient();
  const { data: settingsData } = useGetFeatureSettings(featureId);
  const persistedViewMode = useMemo<GitViewMode>(() => {
    const raw = settingsData?.find((setting) => setting.key === GIT_VIEW_MODE_SETTING)?.value;
    return isGitViewMode(raw) ? raw : fallbackViewMode;
  }, [fallbackViewMode, settingsData]);

  const [viewMode, setLocalViewMode] = useState<GitViewMode>(persistedViewMode);
  useEffect(() => {
    setLocalViewMode(persistedViewMode);
  }, [persistedViewMode]);

  const setFeatureSetting = useSetFeatureSetting({
    mutation: {
      onSuccess: (_response, variables) => {
        const confirmed = variables.data.value;
        if (isGitViewMode(confirmed)) setLocalViewMode(confirmed);
        queryClient.invalidateQueries({ queryKey: getGetFeatureSettingsQueryKey(featureId) });
      },
      onError: (error: unknown) => {
        toast.error(`Could not save Git view setting: ${apiErrorMessage(error, "Unknown error")}`);
      },
    },
  });

  const setViewMode = useCallback(
    (next: GitViewMode) => {
      if (next === viewMode) return;
      setFeatureSetting.mutate({
        id: featureId,
        data: { key: GIT_VIEW_MODE_SETTING, value: next },
      });
    },
    [featureId, setFeatureSetting, viewMode],
  );
  // The mutation already holds the in-flight payload, so mirroring it in local
  // state only bought a second render per click.
  const requestedViewMode = setFeatureSetting.variables?.data.value;
  const pendingViewMode =
    setFeatureSetting.isPending && isGitViewMode(requestedViewMode) ? requestedViewMode : null;

  const {
    value: persistedFileListCollapsed,
    setValue: persistFileListCollapsed,
    isLoading: isFileListCollapseLoading,
  } = useSetting(GIT_SIDEBAR_COLLAPSED_SETTING);
  const fileListCollapsed = persistedFileListCollapsed === "true";
  const setFileListCollapsed = useCallback(
    (collapsed: boolean): void => {
      persistFileListCollapsed(String(collapsed));
    },
    [persistFileListCollapsed],
  );
  const toggleFileList = useCallback((): void => {
    setFileListCollapsed(!fileListCollapsed);
  }, [fileListCollapsed, setFileListCollapsed]);

  return useMemo(
    () => ({
      viewMode,
      setViewMode,
      pendingViewMode,
      fileListCollapsed,
      setFileListCollapsed,
      toggleFileList,
      isFileListCollapseLoading,
    }),
    [
      fileListCollapsed,
      isFileListCollapseLoading,
      pendingViewMode,
      setFileListCollapsed,
      setViewMode,
      toggleFileList,
      viewMode,
    ],
  );
}
