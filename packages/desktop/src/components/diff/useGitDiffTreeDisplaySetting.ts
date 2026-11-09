import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useGetWorkspaceSetting } from "@/api/generated";
import { useSettingWriter } from "@/hooks/useSetting";
import { apiErrorMessage } from "@/lib/api-errors";

export type GitDiffTreeDisplayMode = "tree" | "filenames";

export const GIT_DIFF_TREE_DISPLAY_MODE_KEY = "git_diff_tree_display_mode";

export function parseGitDiffTreeDisplayMode(
  value: string | null | undefined,
): GitDiffTreeDisplayMode {
  return value === "filenames" ? "filenames" : "tree";
}

interface GitDiffTreeDisplaySetting {
  displayMode: GitDiffTreeDisplayMode;
  setDisplayMode: (displayMode: GitDiffTreeDisplayMode) => void;
  isPending: boolean;
}

export function useGitDiffTreeDisplaySetting(): GitDiffTreeDisplaySetting {
  const setting = useGetWorkspaceSetting(GIT_DIFF_TREE_DISPLAY_MODE_KEY);
  const { setValue, isSaving } = useSettingWriter(GIT_DIFF_TREE_DISPLAY_MODE_KEY);
  const errorMessage = setting.error
    ? apiErrorMessage(setting.error, "Unknown settings error")
    : null;
  useEffect(() => {
    if (errorMessage) toast.error(`Could not load Git file-list setting: ${errorMessage}`);
  }, [errorMessage]);
  const setDisplayMode = useCallback(
    (displayMode: GitDiffTreeDisplayMode): void => void setValue(displayMode),
    [setValue],
  );
  const displayMode = parseGitDiffTreeDisplayMode(setting.data?.value);
  const isPending = setting.isLoading || isSaving;
  return useMemo(
    () => ({ displayMode, setDisplayMode, isPending }),
    [displayMode, isPending, setDisplayMode],
  );
}
