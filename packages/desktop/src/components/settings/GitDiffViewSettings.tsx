import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";

import { useGetWorkspaceSetting } from "@/api/generated";
import { useSettingWriter } from "@/hooks/useSetting";
import { RadioCardGroup } from "./RadioCardGroup";
import {
  GIT_DIFF_VIEW_MODE_KEY,
  gitDiffViewModeOptions,
  parseGitDiffViewMode,
  type GitDiffViewMode,
} from "@/lib/git-diff-view-mode";

export function GitDiffViewSettings(): ReactElement {
  const { t } = useUiTranslation();
  const setting = useGetWorkspaceSetting(GIT_DIFF_VIEW_MODE_KEY);
  const { setValue, isSaving } = useSettingWriter(GIT_DIFF_VIEW_MODE_KEY);
  const value = parseGitDiffViewMode(setting.data?.value);

  return (
    <RadioCardGroup<GitDiffViewMode>
      ariaLabel={t("workspace.git.gitDiffViewSettings.diffLayout", "Diff layout")}
      value={value}
      onChange={(next) => void setValue(next)}
      options={gitDiffViewModeOptions(t)}
      layout="grid"
      disabled={setting.isLoading || isSaving}
    />
  );
}
