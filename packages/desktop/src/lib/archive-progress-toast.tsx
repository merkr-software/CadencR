import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { Circle, CircleAlert, CircleCheck, CircleMinus, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { CleanupReport, StepOutcome } from "@/api/generated";
import { scopedToastDescription } from "@/components/ToastScope";
import { apiErrorMessage } from "@/lib/api-errors";
import { ARCHIVE_UNDO_TOAST_MS } from "@/lib/archive-undo";
import {
  cleanupStepLabel,
  doneSummary,
  isSettledReport,
  reportedSteps,
  cleanupStatusLabel,
  stepsNeedingAttention,
  type ReportedStep,
} from "@/lib/archive-cleanup-report";
import { RESET_TOAST_STAGE } from "@/lib/staged-toast";

/**
 * Archives this window started and whose request is still open, by
 * conversation, with their scope line: resolved once, as the archived
 * conversation leaves the cached lists it is read from.
 */
const inProgress = new Map<number, ReactNode>();

function progressToastId(featureId: number): string {
  return `archive-progress-${featureId}`;
}

/**
 * Opens the toast that follows an archive once its dialog has closed: the
 * steps the service planned, then each one as it moves (`app/archive_cleanup`),
 * then the outcome when the request answers.
 */
export function startArchiveProgress(featureId: number): void {
  const scope = scopedToastDescription({ featureId });
  inProgress.set(featureId, scope);
  toast.loading(
    translateUi("conversation.archiveProgressToast.archivingSession", "Archiving session…"),
    {
      ...RESET_TOAST_STAGE,
      id: progressToastId(featureId),
      description: scope,
    },
  );
}

/** A step moved: shown only while this window's request is still open. */
export function updateArchiveProgress(featureId: number, report: CleanupReport): void {
  if (!inProgress.has(featureId)) return;
  const steps = reportedSteps(report);
  if (steps.length === 0) return;
  toast.loading(
    translateUi("conversation.archiveProgressToast.archivingSession", "Archiving session…"),
    {
      ...RESET_TOAST_STAGE,
      id: progressToastId(featureId),
      description: withScope(inProgress.get(featureId), <CleanupStepList steps={steps} />),
    },
  );
}

/**
 * The service ran the whole cleanup before answering. Steps that need the
 * user (interrupted, failed, blocked) are surfaced by `ArchiveCleanupNotices`
 * from the service's journal, on every client: this toast gives way to it.
 */
export function finishArchiveProgress(
  featureId: number,
  report: CleanupReport,
  /**
   * Offered as the toast's Undo (phone layout under a finger, when the archive
   * removed no worktree or branch): unarchives what was archived. The toast
   * then stays `ARCHIVE_UNDO_TOAST_MS`: with no hover to hold it, the default
   * 4s ran out before a thumb reached it, and the tap fell through to what
   * lies under the toast (the drawer's backdrop).
   */
  undo?: () => void,
): void {
  const scope = takeScope(featureId);
  if (stepsNeedingAttention(report).length > 0) {
    toast.dismiss(progressToastId(featureId));
    return;
  }
  const steps = reportedSteps(report);
  const summary = isSettledReport(report) ? doneSummary(report) : <CleanupStepList steps={steps} />;
  toast.success(
    translateUi("conversation.archiveProgressToast.sessionArchived", "Session archived"),
    {
      ...RESET_TOAST_STAGE,
      id: progressToastId(featureId),
      description: withScope(scope, steps.length > 0 ? summary : undefined),
      ...(undo
        ? {
            action: {
              label: translateUi("conversation.archiveProgressToast.undo", "Undo"),
              onClick: undo,
            },
            duration: ARCHIVE_UNDO_TOAST_MS,
          }
        : {}),
    },
  );
}

/**
 * The request failed. `reportLost`: the archive committed (the service
 * announced it) but no answer came back, so its outcome is unknown here and
 * any unfinished step will be listed for review instead.
 */
export function failArchiveProgress(featureId: number, error: unknown, reportLost: boolean): void {
  const scope = takeScope(featureId);
  if (reportLost) {
    toast.warning(
      translateUi(
        "conversation.archiveProgressToast.sessionArchivedButItsCleanupDidNotReportBack",
        "Session archived, but its cleanup did not report back",
      ),
      {
        ...RESET_TOAST_STAGE,
        id: progressToastId(featureId),
        description: withScope(
          scope,
          translateUi(
            "conversation.archive-progress-toast.cleanupReportMissing",
            "The service did not answer before the cleanup finished. Any step left unfinished will be listed for review.",
          ),
        ),
      },
    );
    return;
  }
  toast.error(
    translateUi(
      "conversation.archiveProgressToast.couldNotArchiveSession",
      "Could not archive session",
    ),
    {
      ...RESET_TOAST_STAGE,
      id: progressToastId(featureId),
      description: withScope(
        scope,
        apiErrorMessage(
          error,
          translateUi("conversation.archiveProgressToast.archiveFailed", "Archive failed"),
        ),
      ),
    },
  );
}

function takeScope(featureId: number): ReactNode {
  const scope = inProgress.get(featureId);
  inProgress.delete(featureId);
  return scope;
}

function withScope(scope: ReactNode, body: ReactNode): ReactNode {
  if (scope == null) return body;
  if (body == null) return scope;
  return (
    <>
      {scope}
      <div>{body}</div>
    </>
  );
}

function CleanupStepList({ steps }: { steps: readonly ReportedStep[] }): ReactNode {
  const { t } = useUiTranslation();
  return (
    <ul className="archive-progress-steps">
      {steps.map(({ name, step }) => (
        <li key={name} data-status={step.status}>
          <StepIcon status={step.status} />
          <span>{cleanupStepLabel(name, t)}</span>
          <span className="archive-progress-step-status">{cleanupStatusLabel(step.status, t)}</span>
        </li>
      ))}
    </ul>
  );
}

function StepIcon({ status }: { status: StepOutcome["status"] }): ReactNode {
  switch (status) {
    case "running":
      return <LoaderCircle aria-hidden className="animate-spin" />;
    case "done":
      return <CircleCheck aria-hidden />;
    case "skipped":
      return <CircleMinus aria-hidden />;
    case "pending":
      return <Circle aria-hidden />;
    default:
      return <CircleAlert aria-hidden />;
  }
}
