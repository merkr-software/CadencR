/**
 * Search, filter and grouping for the schedules page.
 *
 * Pure functions so the page can stay a thin shell and the behaviour that
 * actually matters — "can I find the schedule I'm looking for?" — is testable
 * without rendering anything.
 */
import type { Schedule } from "@/api/generated";
import { describeRecurrence, describeTarget, scheduleTitle } from "@/lib/schedules/format";
import { scheduleState, type ScheduleState } from "@/lib/schedules/status";

export type ScheduleFilterState = "all" | ScheduleState;

export interface ScheduleGroup {
  /** Project name, or a placeholder when the project is unknown. */
  label: string;
  /** Used for routing from a group header; `null` when unknown. */
  projectId: number | null;
  schedules: Schedule[];
}

const UNGROUPED = "Other";

/** Counts per filter tab, so the tabs can show what's behind them before you
 *  click. Always computed from the *searched* set, never the filtered one —
 *  otherwise the tab you're on would always read 100%. */
export function stateCounts(schedules: Schedule[]): Record<ScheduleFilterState, number> {
  const counts: Record<ScheduleFilterState, number> = {
    all: schedules.length,
    upcoming: 0,
    failed: 0,
    paused: 0,
    completed: 0,
  };
  for (const schedule of schedules) counts[scheduleState(schedule)] += 1;
  return counts;
}

/**
 * Match against everything the row displays — name, prompt, target, project and
 * the rendered recurrence sentence — so searching "weekday" or the project name
 * finds what the user is looking at, not just what happens to be indexed.
 */
export function searchSchedules(schedules: Schedule[], query: string): Schedule[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return schedules;
  return schedules.filter((schedule) =>
    [
      scheduleTitle(schedule),
      schedule.prompt,
      describeTarget(schedule),
      describeRecurrence(schedule.recurrence),
      schedule.context.project_name ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

export function filterByState(schedules: Schedule[], state: ScheduleFilterState): Schedule[] {
  if (state === "all") return schedules;
  return schedules.filter((schedule) => scheduleState(schedule) === state);
}

/**
 * Group by project, preserving the incoming order (soonest run first) both
 * between groups and inside them — so the project with the next run sits at the
 * top of the page.
 *
 * Keyed on the project id, not its name: two checkouts of the same repo are two
 * projects that happen to share a display name, and merging them would put a
 * schedule under a heading that doesn't own it. It also gives the rendered
 * sections a stable, unique React key.
 */
export function groupByProject(schedules: Schedule[]): ScheduleGroup[] {
  const groups = new Map<number | null, ScheduleGroup>();
  for (const schedule of schedules) {
    const projectId = schedule.context.project_id ?? null;
    const existing = groups.get(projectId);
    if (existing) {
      existing.schedules.push(schedule);
    } else {
      groups.set(projectId, {
        label: schedule.context.project_name ?? UNGROUPED,
        projectId,
        schedules: [schedule],
      });
    }
  }
  return [...groups.values()];
}
