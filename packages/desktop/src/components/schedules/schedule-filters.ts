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
  projectName: string | null;
  /** Used for routing from a group header; `null` when unknown. */
  projectId: number | null;
  schedules: Schedule[];
}

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

interface ScheduleSearchEntry {
  schedule: Schedule;
  text: string;
}

/** Index the text shown on the row once per schedule list and locale. */
export function indexScheduleSearch(schedules: Schedule[], locale: string): ScheduleSearchEntry[] {
  return schedules.map((schedule) => ({
    schedule,
    text: [
      scheduleTitle(schedule),
      schedule.prompt,
      describeTarget(schedule),
      describeRecurrence(schedule.recurrence, locale),
      schedule.context.project_name ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase(locale),
  }));
}

export function searchSchedules(
  index: ScheduleSearchEntry[],
  query: string,
  locale: string,
): Schedule[] {
  const needle = query.trim().toLocaleLowerCase(locale);
  return index.filter(({ text }) => text.includes(needle)).map(({ schedule }) => schedule);
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
        projectName: schedule.context.project_name ?? null,
        projectId,
        schedules: [schedule],
      });
    }
  }
  return [...groups.values()];
}
