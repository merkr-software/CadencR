import type { CustomActionRun } from "@/api/generated";
import { formatRunTime, parseRunTimestamp, STOPPED_EXIT_CODE } from "./run-state";

/** "4s", "2m 05s", "1h 03m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function runDuration(run: CustomActionRun): string | null {
  if (run.ended_at == null) return null;
  return formatDuration(
    parseRunTimestamp(run.ended_at).getTime() - parseRunTimestamp(run.started_at).getTime(),
  );
}

/** "Running since 2 min ago", "Passed in 4s", "Failed (exit 1) in 2m 05s", "Stopped". */
export function runOutcomeText(run: CustomActionRun): string {
  if (run.ended_at == null) return `Running, started ${formatRunTime(run.started_at)}`;
  const duration = runDuration(run);
  const took = duration ? ` in ${duration}` : "";
  if (run.exit_code === 0) return `Passed${took}`;
  if (run.exit_code === STOPPED_EXIT_CODE) return `Stopped after ${duration ?? "a moment"}`;
  return `Failed (exit ${run.exit_code ?? "?"})${took}`;
}

/** One line in the run picker: when, who started it, how it ended. */
export function describeRun(run: CustomActionRun): string {
  const trigger = run.triggered_by === "schedule" ? "scheduled" : "manual";
  const outcome =
    run.ended_at == null
      ? "running"
      : run.exit_code === 0
        ? "passed"
        : run.exit_code === STOPPED_EXIT_CODE
          ? "stopped"
          : `exit ${run.exit_code ?? "?"}`;
  return `${formatRunTime(run.started_at)} · ${trigger} · ${outcome}`;
}
