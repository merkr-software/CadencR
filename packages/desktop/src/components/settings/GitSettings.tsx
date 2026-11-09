import type { ReactElement } from "react";

import { useSetting } from "@/hooks/useSetting";
import { RadioCardGroup } from "./RadioCardGroup";
import { GIT_MERGE_RADIO_OPTIONS } from "./gitMergeRadioOptions";
import { GIT_MERGE_MODE_KEY, parseGitMergeMode, type GitMergeMode } from "@/lib/git-merge-mode";

export function GitSettings(): ReactElement {
  const setting = useSetting(GIT_MERGE_MODE_KEY);
  const value = parseGitMergeMode(setting.value);

  return (
    <RadioCardGroup<GitMergeMode>
      ariaLabel="Merge strategy"
      value={value}
      onChange={(next) => void setting.setValue(next)}
      options={GIT_MERGE_RADIO_OPTIONS}
      layout="grid"
      disabled={setting.isLoading || setting.isSaving}
    />
  );
}
