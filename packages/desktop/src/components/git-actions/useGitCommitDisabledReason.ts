import { useMemo } from "react";
import { useUiTranslation } from "@/lib/i18n/ui";
import { selectGitStatus, useGitStatusStore } from "@/stores/useGitStatusStore";
import { deriveGitAction } from "./useGitAction";
import { useGitUpdatePending } from "./useGitUpdatePending";

/**
 * Why Commit is unavailable for the conversation right now, worded as the
 * header's Git picker words it; `null` when it can commit. For a control
 * outside the header (the phone Git tab's Commit bar) that runs the header's
 * commit through `runShortcutAction("git-commit")`.
 */
export function useGitCommitDisabledReason(featureId: number): string | null {
  const { t } = useUiTranslation();
  const snapshot = useGitStatusStore(selectGitStatus(featureId));
  const statusError = useGitStatusStore((state) => state.healthByFeature[featureId]?.statusError);
  const updatePending = useGitUpdatePending(featureId);
  return useMemo(
    () => deriveGitAction(snapshot, { updatePending, statusError }, t).disabled.commit,
    [snapshot, statusError, t, updatePending],
  );
}
