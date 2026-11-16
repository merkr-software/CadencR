import { formatDistanceToNowStrict } from "date-fns";

import type { CustomAction, LastRunSummary } from "@/api/generated";

/** Where an action's latest run in a conversation stands. */
export type CustomActionRunState = "running" | "failed" | "stopped" | "succeeded" | "idle";

/** Exit code the service records for a run the user stopped (128 + SIGINT). */
export const STOPPED_EXIT_CODE = 130;

/** What a run's state is read from: a list summary or a full run row. */
export type RunOutcome = Pick<LastRunSummary, "ended_at" | "exit_code">;

export function runStateOf(lastRun: RunOutcome | null | undefined): CustomActionRunState {
  if (lastRun == null) return "idle";
  if (lastRun.ended_at == null) return "running";
  if (lastRun.exit_code === 0) return "succeeded";
  // A stop is the user's own doing, not a failure to flag.
  return lastRun.exit_code === STOPPED_EXIT_CODE ? "stopped" : "failed";
}

/**
 * Dot color for the states worth interrupting the header for. A success or an
 * action never run stays quiet: only "something is happening" and "something
 * broke" earn a mark (DESIGN.md status palette: orange in progress, red error).
 */
export const RUN_STATE_DOT_CLASS: Record<CustomActionRunState, string | null> = {
  running: "bg-[var(--acc-orange)]",
  failed: "bg-[var(--acc-red)]",
  stopped: null,
  succeeded: null,
  idle: null,
};

/** Backend timestamps are UTC, with or without the trailing `Z`. */
export function parseRunTimestamp(value: string): Date {
  return new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

export function formatRunTime(value: string): string {
  const date = parseRunTimestamp(value);
  return Number.isNaN(date.getTime())
    ? value
    : formatDistanceToNowStrict(date, { addSuffix: true });
}

/** Short status text, e.g. "Running…", "Failed (exit 2) 3 min ago", "Never run". */
export function runStateText(lastRun: RunOutcome | null | undefined): string {
  const state = runStateOf(lastRun);
  if (state === "idle" || lastRun == null) return "Never run";
  if (state === "running" || lastRun.ended_at == null) return "Running…";
  const when = formatRunTime(lastRun.ended_at);
  if (state === "succeeded") return `Passed ${when}`;
  if (state === "stopped") return `Stopped ${when}`;
  return `Failed (exit ${lastRun.exit_code}) ${when}`;
}

/** The most urgent state across actions, for the launcher's single mark. */
export function aggregateRunState(actions: readonly CustomAction[]): CustomActionRunState {
  const states = actions
    .filter((action) => !action.run_in_terminal)
    .map((a) => runStateOf(a.last_run));
  if (states.includes("running")) return "running";
  if (states.includes("failed")) return "failed";
  return states.includes("succeeded") ? "succeeded" : "idle";
}
