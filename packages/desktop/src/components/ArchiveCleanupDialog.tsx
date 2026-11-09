import { useState, type ReactElement } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  CircleDashedIcon,
  Loader2Icon,
  MinusIcon,
  PauseCircleIcon,
  XCircleIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetArchiveCleanupQueryKey,
  getListArchiveCleanupsQueryKey,
  useGetArchiveCleanup,
  useRetryArchiveCleanup,
  type ArchiveCleanupStatus,
  type RetryArchiveCleanupRequest,
  type StepOutcome,
} from "@/api/generated";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  CLEANUP_STEP_LABELS,
  describeStep,
  reportedSteps,
  type ReportedStep,
} from "@/lib/archive-cleanup-report";
import { useArchiveCleanupReviewStore } from "@/stores/archive-cleanup-review-store";

type ForcedStep = "worktree" | "branch";

const FORCE_CONFIRMATIONS: Record<
  ForcedStep,
  { action: string; title: string; description: string; request: RetryArchiveCleanupRequest }
> = {
  worktree: {
    action: "Discard changes & remove worktree",
    title: "Discard uncommitted changes?",
    description:
      "The worktree has uncommitted or untracked changes. Removing it anyway permanently loses them.",
    request: { force_remove_worktree: true },
  },
  branch: {
    action: "Delete unmerged branch",
    title: "Delete an unmerged branch?",
    description:
      "The branch has commits that are not merged into its target. Deleting it anyway loses them unless they exist elsewhere (for example a squash-merged pull request).",
    request: { force_remove_branch: true },
  },
};

/**
 * The cleanup of an archived conversation as the service journaled it, with
 * what the user can do about it: resume the steps an interruption or a
 * failure left, or confirm forcing a step that refused to lose work. Every
 * state shown comes from the service (query + `app/archive_cleanup` events).
 */
export function ArchiveCleanupDialog(): ReactElement {
  const featureId = useArchiveCleanupReviewStore((state) => state.featureId);
  const close = useArchiveCleanupReviewStore((state) => state.close);
  const [confirming, setConfirming] = useState<ForcedStep | null>(null);
  const queryClient = useQueryClient();
  const query = useGetArchiveCleanup(featureId ?? 0, {
    query: { enabled: featureId != null, retry: false },
  });
  const retry = useRetryArchiveCleanup({
    mutation: {
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: getListArchiveCleanupsQueryKey() });
        if (featureId != null) {
          void queryClient.invalidateQueries({ queryKey: getGetArchiveCleanupQueryKey(featureId) });
        }
      },
    },
  });
  const status = query.data;
  const busy = retry.isPending || status?.running === true;
  const run = (request: RetryArchiveCleanupRequest): Promise<void> =>
    featureId == null
      ? Promise.resolve()
      : retry.mutateAsync({ id: featureId, data: request }).then(
          () => undefined,
          () => undefined,
        );

  return (
    <>
      <Dialog open={featureId != null} onOpenChange={(open) => !open && close()}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Archive cleanup</DialogTitle>
            <DialogDescription>
              {status ? `“${status.title}”` : "Cleanup of an archived session"}
            </DialogDescription>
          </DialogHeader>
          <CleanupBody query={query} />
          {retry.error != null && (
            <p role="alert" className="text-xs text-destructive">
              {apiErrorMessage(retry.error, "Could not resume the cleanup")}
            </p>
          )}
          <DialogFooter>
            {status && !status.settled && (
              <CleanupActions
                status={status}
                busy={busy}
                onResume={() => void run({})}
                onForce={setConfirming}
              />
            )}
            <Button variant="outline" onClick={close}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirming != null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? FORCE_CONFIRMATIONS[confirming].title : ""}
        description={confirming ? FORCE_CONFIRMATIONS[confirming].description : undefined}
        confirmText={confirming ? FORCE_CONFIRMATIONS[confirming].action : "Confirm"}
        variant="destructive"
        busy={retry.isPending}
        onConfirm={() => (confirming ? run(FORCE_CONFIRMATIONS[confirming].request) : undefined)}
      />
    </>
  );
}

function CleanupBody({
  query,
}: {
  query: { isLoading: boolean; error: unknown; data: ArchiveCleanupStatus | undefined };
}): ReactElement {
  if (query.isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" /> Loading the cleanup…
      </p>
    );
  }
  if (query.error != null || !query.data) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {apiErrorMessage(query.error, "This session has no archive cleanup")}
      </p>
    );
  }
  return (
    <ul className="space-y-2" aria-label="Cleanup steps">
      {reportedSteps(query.data.cleanup).map((entry) => (
        <CleanupStepRow key={entry.name} entry={entry} />
      ))}
    </ul>
  );
}

function CleanupStepRow({ entry }: { entry: ReportedStep }): ReactElement {
  return (
    <li className="flex items-start gap-3 rounded-md border p-3 text-sm">
      <span className="mt-0.5">{statusIcon(entry.step.status)}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{CLEANUP_STEP_LABELS[entry.name]}</span>
        <span className="block break-words text-xs text-muted-foreground">
          {describeStep(entry)}
        </span>
      </span>
    </li>
  );
}

function statusIcon(status: StepOutcome["status"]): ReactElement {
  switch (status) {
    case "done":
      return <CheckIcon className="size-4 text-primary" aria-label="Done" />;
    case "skipped":
      return <MinusIcon className="size-4 text-muted-foreground" aria-label="Skipped" />;
    case "running":
      return <Loader2Icon className="size-4 animate-spin" aria-label="In progress" />;
    case "pending":
      return <CircleDashedIcon className="size-4 text-muted-foreground" aria-label="Pending" />;
    case "interrupted":
      return (
        <PauseCircleIcon
          className="size-4 text-amber-600 dark:text-amber-400"
          aria-label="Interrupted"
        />
      );
    case "blocked":
      return (
        <AlertTriangleIcon
          className="size-4 text-amber-600 dark:text-amber-400"
          aria-label="Blocked"
        />
      );
    case "failed":
      return <XCircleIcon className="size-4 text-destructive" aria-label="Failed" />;
  }
}

function CleanupActions(props: {
  status: ArchiveCleanupStatus;
  busy: boolean;
  onResume: () => void;
  onForce: (step: ForcedStep) => void;
}): ReactElement {
  const blocked = (["worktree", "branch"] as const).filter(
    (name) => props.status.cleanup[name]?.status === "blocked",
  );
  return (
    <>
      {blocked.map((name) => (
        <Button
          key={name}
          variant="destructive"
          disabled={props.busy}
          onClick={() => props.onForce(name)}
        >
          {FORCE_CONFIRMATIONS[name].action}…
        </Button>
      ))}
      <Button disabled={props.busy} aria-busy={props.busy} onClick={props.onResume}>
        {props.busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
        {props.busy ? "Cleaning up…" : "Resume cleanup"}
      </Button>
    </>
  );
}
