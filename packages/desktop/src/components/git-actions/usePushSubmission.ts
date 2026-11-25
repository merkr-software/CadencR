import { translateUi } from "@/lib/i18n/ui";
import { useCallback, useMemo, useState } from "react";
import { PushForceMode, usePush } from "@/api/generated";
import { selectPushStatus, usePushOutputStore } from "@/stores/usePushOutputStore";
import {
  useGitOutputSubmission,
  type GitOutputSubmissionController,
  type GitOutputSubmissionCopy,
} from "./useGitOutputSubmission";

interface UsePushSubmissionOptions {
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface PushSubmissionController extends GitOutputSubmissionController<PushForceMode> {
  /**
   * Selected force mode. Owned here rather than in the dialog because the
   * dialog unmounts whenever the push is backgrounded — a local copy would
   * offer "Retry — push" for a run that was `--force`.
   */
  force: PushForceMode;
  setForce: (mode: PushForceMode) => void;
  /**
   * Offset of the last ssh prompt the user answered, compared against
   * `detectSshPrompt`'s output so a *new* prompt further down the buffer
   * re-shows the input. Hoisted for the same reason as `force`: kept local
   * it would re-ask an already-answered passphrase on every reopen.
   */
  answeredOffset: number;
  markPromptAnswered: (offset: number) => void;
}

function submissionCopy(): GitOutputSubmissionCopy {
  return {
    failure: translateUi("workspace.git.usePushSubmission.pushFailed", "Push failed"),
    failureHint: translateUi(
      "workspace.git.usePushSubmission.openThePushOutputToInspectThe",
      "Open the push output to inspect the error.",
    ),
    success: translateUi("workspace.git.usePushSubmission.pushed", "Pushed"),
    backgroundSuccess: translateUi(
      "workspace.git.usePushSubmission.backgroundPushCompleted",
      "Background push completed",
    ),
  };
}

export function usePushSubmission({
  featureId,
  open,
  onOpenChange,
}: UsePushSubmissionOptions): PushSubmissionController {
  const push = usePush();
  const [force, setForce] = useState<PushForceMode>(PushForceMode.none);
  const [answeredOffset, setAnsweredOffset] = useState(-1);

  const run = useCallback(
    (mode: PushForceMode) => push.mutateAsync({ data: { feature_id: featureId, force: mode } }),
    [featureId, push],
  );
  const onStart = useCallback(() => setAnsweredOffset(-1), []);
  // A finished push starts over from the safe default; only a run still
  // worth retrying keeps its mode.
  const onSuccess = useCallback(() => setForce(PushForceMode.none), []);

  const controller = useGitOutputSubmission<PushForceMode>({
    featureId,
    open,
    onOpenChange,
    useStore: usePushOutputStore,
    selectStatus: selectPushStatus,
    isPending: push.isPending,
    run,
    copy: submissionCopy,
    onStart,
    onSuccess,
  });

  return useMemo(
    () => ({
      ...controller,
      force,
      setForce,
      answeredOffset,
      markPromptAnswered: setAnsweredOffset,
    }),
    [answeredOffset, controller, force],
  );
}
