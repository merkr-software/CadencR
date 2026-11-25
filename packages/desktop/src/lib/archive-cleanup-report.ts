import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import type { CleanupReport, StepOutcome } from "@/api/generated";

export type CleanupStepName = "terminals" | "browser_tabs" | "worktree" | "branch";

/** The service's run order. */
export const CLEANUP_STEPS: readonly CleanupStepName[] = [
  "terminals",
  "browser_tabs",
  "worktree",
  "branch",
];

const CLEANUP_STEP_LABELS: Record<CleanupStepName, (t: UiTranslator) => string> = {
  terminals: (t) => t("conversation.archive-cleanup-report.terminals", "Terminals"),
  browser_tabs: (t) => t("conversation.archive-cleanup-report.browserTabs", "Browser tabs"),
  worktree: (t) => t("conversation.archive-cleanup-report.worktree", "Worktree"),
  branch: (t) => t("conversation.archive-cleanup-report.branch", "Branch"),
};

export interface ReportedStep {
  name: CleanupStepName;
  step: StepOutcome;
}

/** The requested steps, in run order. */
export function reportedSteps(report: CleanupReport): ReportedStep[] {
  return CLEANUP_STEPS.flatMap((name) => {
    const step = report[name];
    return step ? [{ name, step }] : [];
  });
}

/** Steps only the user can move forward: resume them, or confirm forcing them. */
export function stepsNeedingAttention(report: CleanupReport): ReportedStep[] {
  return reportedSteps(report).filter(({ step }) =>
    ["interrupted", "failed", "blocked"].includes(step.status),
  );
}

export function isSettledReport(report: CleanupReport): boolean {
  return reportedSteps(report).every(
    ({ step }) => step.status === "done" || step.status === "skipped",
  );
}

/** What the user reads for a step: its outcome, then why. */
export function describeStep({ step }: ReportedStep, t: UiTranslator = translateUi): string {
  const why = step.message ?? step.reason ?? step.detail;
  const status = cleanupStatusLabel(step.status, t);
  return why
    ? t("conversation.archive-cleanup-report.statusWithDetail", "{{status}}: {{detail}}", {
        status,
        detail: why,
      })
    : status;
}

const STATUS_LABELS: Record<StepOutcome["status"], (t: UiTranslator) => string> = {
  pending: (t) => t("conversation.archive-cleanup-report.pending", "Pending"),
  running: (t) => t("conversation.archive-cleanup-report.inProgress", "In progress"),
  interrupted: (t) => t("conversation.archive-cleanup-report.interrupted", "Interrupted"),
  done: (t) => t("conversation.archive-cleanup-report.done", "Done"),
  skipped: (t) => t("conversation.archive-cleanup-report.skipped", "Skipped"),
  blocked: (t) => t("conversation.archive-cleanup-report.blocked", "Blocked"),
  failed: (t) => t("conversation.archive-cleanup-report.failed", "Failed"),
};

export function cleanupStepLabel(name: CleanupStepName, t: UiTranslator = translateUi): string {
  return CLEANUP_STEP_LABELS[name](t);
}

export function cleanupStatusLabel(
  status: StepOutcome["status"],
  t: UiTranslator = translateUi,
): string {
  return STATUS_LABELS[status](t);
}

/** One line per step for a toast description. */
export function reportDescription(steps: readonly ReportedStep[]): string {
  return steps
    .map((entry) =>
      translateUi("conversation.archive-cleanup-report.stepWithStatus", "{{step}}: {{status}}", {
        step: cleanupStepLabel(entry.name),
        status: describeStep(entry),
      }),
    )
    .join("\n");
}

/** The steps that did something, for a success toast. */
export function doneSummary(report: CleanupReport): string | undefined {
  const done = reportedSteps(report).filter(({ step }) => step.status === "done");
  if (done.length === 0) return undefined;
  const steps = done.map(({ name }) => cleanupStepLabel(name).toLowerCase());
  return translateUi(
    "conversation.archiveCleanupReport.cleanupFinished",
    "Cleanup finished: {{steps}}.",
    { steps: steps.join(", ") },
  );
}
