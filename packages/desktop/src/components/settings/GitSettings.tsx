import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";

import { useSetting } from "@/hooks/useSetting";
import { RadioCardGroup } from "./RadioCardGroup";
import { gitMergeRadioOptions } from "./gitMergeRadioOptions";
import { GIT_MERGE_MODE_KEY, parseGitMergeMode, type GitMergeMode } from "@/lib/git-merge-mode";

export function GitSettings(): ReactElement {
  const { t } = useUiTranslation();
  const setting = useSetting(GIT_MERGE_MODE_KEY);
  const value = parseGitMergeMode(setting.value);

  return (
    <RadioCardGroup<GitMergeMode>
      ariaLabel={t("workspace.git.gitSettings.mergeStrategy", "Merge strategy")}
      value={value}
      onChange={(next) => void setting.setValue(next)}
      options={gitMergeRadioOptions(t)}
      layout="grid"
      disabled={setting.isLoading || setting.isSaving}
    />
  );
}
