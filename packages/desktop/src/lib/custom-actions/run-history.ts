import { translateUi as t } from "@/lib/i18n/ui";
import type { CustomActionRun } from "@/api/generated";
import { formatRunTime, parseRunTimestamp, STOPPED_EXIT_CODE } from "./run-state";

/** "4s", "2m 05s", "1h 03m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t("customActions.duration.seconds", "{{seconds, number}}s", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return t(
      "customActions.duration.minutesSeconds",
      "{{minutes, number}}m {{seconds, number(minimumIntegerDigits: 2)}}s",
      { minutes, seconds: seconds % 60 },
    );
  return t(
    "customActions.duration.hoursMinutes",
    "{{hours, number}}h {{minutes, number(minimumIntegerDigits: 2)}}m",
    { hours: Math.floor(minutes / 60), minutes: minutes % 60 },
  );
}

export function runDuration(run: CustomActionRun): string | null {
  if (run.ended_at == null) return null;
  return formatDuration(
    parseRunTimestamp(run.ended_at).getTime() - parseRunTimestamp(run.started_at).getTime(),
  );
}

/** "Running since 2 min ago", "Passed in 4s", "Failed (exit 1) in 2m 05s", "Stopped". */
export function runOutcomeText(run: CustomActionRun): string {
  if (run.ended_at == null)
    return t("customActions.history.started", "Running, started {{when}}", {
      when: formatRunTime(run.started_at),
    });
  const duration = runDuration(run);
  if (run.exit_code === 0)
    return t("customActions.history.passedIn", "Passed in {{duration}}", { duration });
  if (run.exit_code === STOPPED_EXIT_CODE)
    return t("customActions.history.stoppedAfter", "Stopped after {{duration}}", { duration });
  return t("customActions.history.failedIn", "Failed (exit {{exit}}) in {{duration}}", {
    exit: run.exit_code ?? "?",
    duration,
  });
}

/** One line in the run picker: when, who started it, how it ended. */
export function describeRun(run: CustomActionRun): string {
  const trigger =
    run.triggered_by === "schedule"
      ? t("customActions.history.scheduled", "scheduled")
      : t("customActions.history.manual", "manual");
  const outcome =
    run.ended_at == null
      ? t("customActions.history.running", "running")
      : run.exit_code === 0
        ? t("customActions.history.passed", "passed")
        : run.exit_code === STOPPED_EXIT_CODE
          ? t("customActions.history.stopped", "stopped")
          : t("customActions.history.exit", "exit {{exit}}", { exit: run.exit_code ?? "?" });
  return t("customActions.history.row", "{{when}} · {{trigger}} · {{outcome}}", {
    when: formatRunTime(run.started_at),
    trigger,
    outcome,
  });
}
