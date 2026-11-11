import { Circle, CircleAlert, CircleCheck, CircleMinus, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { CleanupReport, StepOutcome } from "@/api/generated";
import { scopedToastDescription } from "@/components/ToastScope";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  CLEANUP_STEP_LABELS,
  doneSummary,
  isSettledReport,
  reportedSteps,
  STATUS_LABELS,
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
  toast.loading("Archiving session…", {
    ...RESET_TOAST_STAGE,
    id: progressToastId(featureId),
    description: scope,
  });
}

/** A step moved: shown only while this window's request is still open. */
export function updateArchiveProgress(featureId: number, report: CleanupReport): void {
  if (!inProgress.has(featureId)) return;
  const steps = reportedSteps(report);
  if (steps.length === 0) return;
  toast.loading("Archiving session…", {
    ...RESET_TOAST_STAGE,
    id: progressToastId(featureId),
    description: withScope(inProgress.get(featureId), <CleanupStepList steps={steps} />),
  });
}

/**
 * The service ran the whole cleanup before answering. Steps that need the
 * user (interrupted, failed, blocked) are surfaced by `ArchiveCleanupNotices`
 * from the service's journal, on every client: this toast gives way to it.
 */
export function finishArchiveProgress(featureId: number, report: CleanupReport): void {
  const scope = takeScope(featureId);
  if (stepsNeedingAttention(report).length > 0) {
    toast.dismiss(progressToastId(featureId));
    return;
  }
  const steps = reportedSteps(report);
  const summary = isSettledReport(report) ? doneSummary(report) : <CleanupStepList steps={steps} />;
  toast.success("Session archived", {
    ...RESET_TOAST_STAGE,
    id: progressToastId(featureId),
    description: withScope(scope, steps.length > 0 ? summary : undefined),
  });
}

/**
 * The request failed. `reportLost`: the archive committed (the service
 * announced it) but no answer came back, so its outcome is unknown here and
 * any unfinished step will be listed for review instead.
 */
export function failArchiveProgress(featureId: number, error: unknown, reportLost: boolean): void {
  const scope = takeScope(featureId);
  if (reportLost) {
    toast.warning("Session archived, but its cleanup did not report back", {
      ...RESET_TOAST_STAGE,
      id: progressToastId(featureId),
      description: withScope(
        scope,
        "The service did not answer before the cleanup finished. Any step left unfinished will be listed for review.",
      ),
    });
    return;
  }
  toast.error("Could not archive session", {
    ...RESET_TOAST_STAGE,
    id: progressToastId(featureId),
    description: withScope(scope, apiErrorMessage(error, "Archive failed")),
  });
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
  return (
    <ul className="archive-progress-steps">
      {steps.map(({ name, step }) => (
        <li key={name} data-status={step.status}>
          <StepIcon status={step.status} />
          <span>{CLEANUP_STEP_LABELS[name]}</span>
          <span className="archive-progress-step-status">{STATUS_LABELS[step.status]}</span>
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
