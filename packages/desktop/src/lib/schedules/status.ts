/**
 * The one place a schedule's state is named.
 *
 * A schedule row has to answer "is this going to happen, and did the last one
 * work?" from four independent fields (`enabled`, `completed`, `next_run_at`,
 * `last_run.status`). Deriving that in each component would guarantee the
 * sidebar count, the filter chips and the row badge eventually disagree.
 */
import type { Schedule } from "@/api/generated";
import type { UiTranslator } from "@/lib/i18n/ui";

export type ScheduleState = "upcoming" | "failed" | "paused" | "completed";

export function scheduleStateLabel(t: UiTranslator, state: ScheduleState): string {
  switch (state) {
    case "upcoming":
      return t("schedule.list.status.upcoming", "Upcoming");
    case "failed":
      return t("schedule.list.status.failed", "Failed");
    case "paused":
      return t("schedule.list.status.paused", "Paused");
    case "completed":
      return t("schedule.list.status.completed", "Done");
  }
}

/**
 * Order matters: a paused schedule is paused even if its last run failed (the
 * user already acted on it), and a finished one-off is finished even though it
 * is nominally still enabled.
 */
export function scheduleState(schedule: Schedule): ScheduleState {
  if (!schedule.enabled) return "paused";
  if (schedule.completed) return "completed";
  if (schedule.last_run?.status === "failed") return "failed";
  return "upcoming";
}

/** Schedules that will fire again unless the user intervenes. This is the
 *  number the sidebar badge shows — "how much is armed right now". */
export function isActive(schedule: Schedule): boolean {
  return schedule.enabled && !schedule.completed && !!schedule.next_run_at;
}

/** The soonest upcoming run across a set, for the sidebar tooltip. */
export function nextRunAcross(schedules: Schedule[]): Date | null {
  const times = schedules
    .filter(isActive)
    .map((schedule) => new Date(schedule.next_run_at as string).getTime())
    .filter((time) => Number.isFinite(time));
  return times.length ? new Date(Math.min(...times)) : null;
}
