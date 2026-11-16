import type { ReactElement } from "react";

import { useGetWorkspaceSetting } from "@/api/generated";
import { useSettingWriter } from "@/hooks/useSetting";
import { RadioCardGroup } from "./RadioCardGroup";
import {
  GIT_DIFF_VIEW_MODE_KEY,
  GIT_DIFF_VIEW_MODE_OPTIONS,
  parseGitDiffViewMode,
  type GitDiffViewMode,
} from "@/lib/git-diff-view-mode";

export function GitDiffViewSettings(): ReactElement {
  const setting = useGetWorkspaceSetting(GIT_DIFF_VIEW_MODE_KEY);
  const { setValue, isSaving } = useSettingWriter(GIT_DIFF_VIEW_MODE_KEY);
  const value = parseGitDiffViewMode(setting.data?.value);

  return (
    <RadioCardGroup<GitDiffViewMode>
      ariaLabel="Diff layout"
      value={value}
      onChange={(next) => void setValue(next)}
      options={GIT_DIFF_VIEW_MODE_OPTIONS}
      layout="grid"
      disabled={setting.isLoading || isSaving}
    />
  );
}
