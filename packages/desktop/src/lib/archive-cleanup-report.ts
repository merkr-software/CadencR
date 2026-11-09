import type { CleanupReport, StepOutcome } from "@/api/generated";

export type CleanupStepName = "terminals" | "browser_tabs" | "worktree" | "branch";

/** The service's run order. */
export const CLEANUP_STEPS: readonly CleanupStepName[] = [
  "terminals",
  "browser_tabs",
  "worktree",
  "branch",
];

export const CLEANUP_STEP_LABELS: Record<CleanupStepName, string> = {
  terminals: "Terminals",
  browser_tabs: "Browser tabs",
  worktree: "Worktree",
  branch: "Branch",
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
export function describeStep({ step }: ReportedStep): string {
  const why = step.message ?? step.reason ?? step.detail;
  const status = STATUS_LABELS[step.status];
  return why ? `${status}: ${why}` : status;
}

const STATUS_LABELS: Record<StepOutcome["status"], string> = {
  pending: "Pending",
  running: "In progress",
  interrupted: "Interrupted",
  done: "Done",
  skipped: "Skipped",
  blocked: "Blocked",
  failed: "Failed",
};

/** One line per step for a toast description. */
export function reportDescription(steps: readonly ReportedStep[]): string {
  return steps
    .map((entry) => `${CLEANUP_STEP_LABELS[entry.name]}: ${describeStep(entry)}`)
    .join("\n");
}

/** The steps that did something, for a success toast. */
export function doneSummary(report: CleanupReport): string | undefined {
  const done = reportedSteps(report).filter(({ step }) => step.status === "done");
  if (done.length === 0) return undefined;
  return `Cleanup finished: ${done.map(({ name }) => CLEANUP_STEP_LABELS[name].toLowerCase()).join(", ")}.`;
}
