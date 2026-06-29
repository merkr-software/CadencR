import type { ReactElement } from "react";

import { useGetWorkspaceSetting } from "@/api/generated";
import { useSetWorkspaceSettingWithCache } from "@/hooks/useSetWorkspaceSettingWithCache";
import { RadioCardGroup } from "./RadioCardGroup";
import {
  GIT_DIFF_VIEW_MODE_KEY,
  GIT_DIFF_VIEW_MODE_OPTIONS,
  parseGitDiffViewMode,
  type GitDiffViewMode,
} from "@/lib/git-diff-view-mode";

export function GitDiffViewSettings(): ReactElement {
  const setting = useGetWorkspaceSetting(GIT_DIFF_VIEW_MODE_KEY);
  const { setValue, isPending } = useSetWorkspaceSettingWithCache(GIT_DIFF_VIEW_MODE_KEY);
  const value = parseGitDiffViewMode(setting.data?.value);

  return (
    <RadioCardGroup<GitDiffViewMode>
      ariaLabel="Diff layout"
      value={value}
      onChange={(next) => {
        setValue(next).catch((error: unknown) => {
          console.warn("Diff view mode setting save failed after user-facing toast", error);
        });
      }}
      options={GIT_DIFF_VIEW_MODE_OPTIONS}
      layout="grid"
      disabled={setting.isLoading || isPending}
    />
  );
}
