/**
 * Submission controller for the streaming Git actions (commit, push).
 *
 * Lives *outside* the dialog so a run survives closing it: the mutation and
 * the store entry are owned by `GitActionButton`, which keeps rendering
 * while the dialog unmounts. That is what makes "run in background, reopen
 * later" work — reopening remounts a view over state that never went away.
 */
import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { StoreApi, UseBoundStore } from "zustand";

import { scopedToastDescription } from "@/components/ToastScope";
import { apiErrorMessage } from "@/lib/api-errors";
import type {
  GitOutputOutcome,
  GitOutputState,
  GitOutputStatus,
} from "@/stores/createGitOutputStore";

export interface GitOutputSubmissionResult {
  success: boolean;
  error?: string | null;
}

export interface GitOutputSubmissionCopy {
  /** Toast title on failure, and the fallback detail written to the buffer. */
  failure: string;
  /** Toast body of a *backgrounded* failure, pointing at the output. */
  failureHint: string;
  /** Toast title when the run finishes with the dialog open. */
  success: string;
  /** …and when it finishes after being backgrounded. */
  backgroundSuccess: string;
}

interface UseGitOutputSubmissionOptions<TArgs> {
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  useStore: UseBoundStore<StoreApi<GitOutputState>>;
  selectStatus: (featureId: number) => (state: GitOutputState) => GitOutputStatus | null;
  isPending: boolean;
  run: (args: TArgs) => Promise<GitOutputSubmissionResult>;
  copy: GitOutputSubmissionCopy;
  /** Fired once the run is registered — clears per-run dialog state. */
  onStart?: () => void;
  /** Fired after a successful run, before the dialog closes. */
  onSuccess?: () => void;
}

export interface GitOutputSubmissionController<TArgs> {
  outcome: GitOutputOutcome;
  submitting: boolean;
  submit: (args: TArgs) => Promise<void>;
  onDialogOpenChange: (open: boolean) => void;
}

export function useGitOutputSubmission<TArgs>({
  featureId,
  open,
  onOpenChange,
  useStore,
  selectStatus,
  isPending,
  run,
  copy,
  onStart,
  onSuccess,
}: UseGitOutputSubmissionOptions<TArgs>): GitOutputSubmissionController<TArgs> {
  const status = useStore(selectStatus(featureId));
  const outcome: GitOutputOutcome = status === "success" || status === "error" ? status : null;
  const submitting = isPending || status === "running";

  // Everything `submit` needs beyond the store goes through refs: a run
  // streams output many times per second, and a `submit` that changed
  // identity on each chunk would re-render the whole dialog with it.
  const openRef = useRef(open);
  openRef.current = open;
  const latest = useRef({ run, copy, onStart, onSuccess });
  latest.current = { run, copy, onStart, onSuccess };

  const onDialogOpenChange = useCallback(
    (nextOpen: boolean): void => {
      openRef.current = nextOpen;
      // Dismissing a finished failure discards its output; a still-running
      // one is merely backgrounded and keeps streaming. Read the status from
      // the store rather than the render that created this callback — it is
      // deliberately stable, so a captured copy would be stale.
      if (!nextOpen && useStore.getState().byFeature[featureId]?.status === "error") {
        useStore.getState().reset(featureId);
      }
      onOpenChange(nextOpen);
    },
    [featureId, onOpenChange, useStore],
  );

  const submit = useCallback(
    async (args: TArgs): Promise<void> => {
      const { run: startRun, copy: text, onStart: started, onSuccess: succeeded } = latest.current;
      const store = useStore.getState();
      // The backend refuses a second PTY for this feature anyway; keep
      // showing the run that is already streaming.
      if (store.byFeature[featureId]?.status === "running") return;
      // `start` replaces any prior entry, so a retry never shows the
      // previous run's output.
      store.start(featureId);
      started?.();

      const fail = (detail: string): void => {
        useStore.getState().fail(featureId, detail);
        if (openRef.current) return;
        toast.error(text.failure, {
          description: scopedToastDescription({ featureId }, text.failureHint),
          action: { label: "View output", onClick: () => onDialogOpenChange(true) },
        });
      };

      try {
        const result = await startRun(args);
        if (!result.success) {
          fail(result.error ?? `${text.failure}.`);
          return;
        }
        // Drop the finished run instead of parking it in the store: nothing
        // reads a successful buffer, and keeping it would greet the next
        // open with the previous run's output.
        useStore.getState().reset(featureId);
        succeeded?.();
        if (openRef.current) {
          toast.success(text.success);
          // Close *this* dialog only. There is a single `activeDialog` slot,
          // so a backgrounded run resolving must not slam shut whatever the
          // user opened in the meantime.
          onDialogOpenChange(false);
        } else {
          // A backgrounded run can land while the user is in another project.
          toast.success(text.backgroundSuccess, {
            description: scopedToastDescription({ featureId }),
          });
        }
      } catch (error) {
        fail(apiErrorMessage(error, `${text.failure}.`));
      }
    },
    [featureId, onDialogOpenChange, useStore],
  );

  return useMemo(
    () => ({ outcome, submitting, submit, onDialogOpenChange }),
    [onDialogOpenChange, outcome, submit, submitting],
  );
}
