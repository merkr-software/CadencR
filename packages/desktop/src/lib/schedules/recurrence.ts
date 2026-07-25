/**
 * Editor-side model of a recurrence rule.
 *
 * The backend owns one rule shape; the editor needs a slightly wider one so a
 * user can switch between "every day" and "every 15 minutes" without losing the
 * fields of the kind they just left. `RecurrenceDraft` therefore keeps every
 * kind's fields populated at all times and `draftToInput` narrows it to the
 * wire shape on save — which is also why the backend drops fields that don't
 * belong to the chosen kind rather than trusting the client to.
 */
import type { Recurrence, RecurrenceInput, RecurrenceKind } from "@/api/generated";

export type IntervalUnit = "minutes" | "hours";

export const UNIT_SECONDS: Record<IntervalUnit, number> = { minutes: 60, hours: 3600 };

/** Matches the backend's floor; anything shorter is a runaway loop. */
export const MIN_INTERVAL_SECONDS = 60;

export interface RecurrenceDraft {
  kind: RecurrenceKind;
  /** `once`: the absolute local instant to fire at. */
  runAt: Date;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  /** `HH:MM`, local wall clock. */
  timeOfDay: string;
  /** ISO weekdays, 1 = Monday .. 7 = Sunday. */
  weekdays: number[];
  dayOfMonth: number;
}

const ONE_HOUR_MS = 60 * 60_000;

/** The viewer's IANA timezone, e.g. `Europe/Paris`. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

export function toTimeOfDay(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function parseTimeOfDay(value: string): { hours: number; minutes: number } {
  const [hours, minutes] = value.split(":");
  return { hours: Number(hours) || 0, minutes: Number(minutes) || 0 };
}

/** ISO weekday (1 = Monday .. 7 = Sunday) for a local date. */
function isoWeekday(date: Date): number {
  return date.getDay() === 0 ? 7 : date.getDay();
}

export function emptyDraft(now: Date = new Date()): RecurrenceDraft {
  const start = new Date(now.getTime() + ONE_HOUR_MS);
  return {
    kind: "once",
    runAt: start,
    intervalValue: 30,
    intervalUnit: "minutes",
    timeOfDay: "09:00",
    weekdays: [isoWeekday(now)],
    dayOfMonth: now.getDate(),
  };
}

/** Rebuild editor state from a saved rule, filling the other kinds' fields with
 *  sensible defaults so switching kinds in the editor never lands on a blank. */
export function toDraft(
  recurrence: Recurrence,
  nextRunAt: string | null | undefined,
  now: Date = new Date(),
): RecurrenceDraft {
  const base = emptyDraft(now);
  const seconds = recurrence.interval_seconds ?? null;
  return {
    kind: recurrence.kind,
    runAt: nextRunAt ? new Date(nextRunAt) : base.runAt,
    ...(seconds
      ? intervalToUnitValue(seconds)
      : { intervalValue: base.intervalValue, intervalUnit: base.intervalUnit }),
    timeOfDay: recurrence.time_of_day ?? base.timeOfDay,
    weekdays: recurrence.weekdays?.length ? [...recurrence.weekdays] : base.weekdays,
    dayOfMonth: recurrence.day_of_month ?? base.dayOfMonth,
  };
}

/** Pick the largest unit that divides evenly, so 3600s reads back as "1 hour". */
function intervalToUnitValue(seconds: number): {
  intervalValue: number;
  intervalUnit: IntervalUnit;
} {
  if (seconds >= UNIT_SECONDS.hours && seconds % UNIT_SECONDS.hours === 0) {
    return { intervalValue: seconds / UNIT_SECONDS.hours, intervalUnit: "hours" };
  }
  return { intervalValue: Math.round(seconds / 60), intervalUnit: "minutes" };
}

export function draftIntervalSeconds(draft: RecurrenceDraft): number {
  return Math.round(draft.intervalValue) * UNIT_SECONDS[draft.intervalUnit];
}

export function draftToInput(draft: RecurrenceDraft): RecurrenceInput {
  const timezone = localTimeZone();
  switch (draft.kind) {
    case "once":
      return { kind: "once", run_at: draft.runAt.toISOString(), timezone };
    case "interval":
      return { kind: "interval", interval_seconds: draftIntervalSeconds(draft), timezone };
    case "weekly":
      return {
        kind: "weekly",
        time_of_day: draft.timeOfDay,
        weekdays: [...draft.weekdays].sort((a, b) => a - b),
        timezone,
      };
    case "monthly":
      return {
        kind: "monthly",
        time_of_day: draft.timeOfDay,
        day_of_month: draft.dayOfMonth,
        timezone,
      };
    default:
      return { kind: "daily", time_of_day: draft.timeOfDay, timezone };
  }
}

/** Why a draft can't be saved yet, or `null` when it can. */
export function draftError(draft: RecurrenceDraft, now: Date = new Date()): string | null {
  switch (draft.kind) {
    case "once":
      return draft.runAt.getTime() <= now.getTime() ? "Pick a time in the future." : null;
    case "interval":
      return draftIntervalSeconds(draft) < MIN_INTERVAL_SECONDS
        ? "The shortest interval is 1 minute."
        : null;
    case "weekly":
      return draft.weekdays.length === 0 ? "Pick at least one day." : null;
    case "monthly":
      return draft.dayOfMonth < 1 || draft.dayOfMonth > 31 ? "Pick a day between 1 and 31." : null;
    default:
      return null;
  }
}

/**
 * The next `count` firings, in local time — the editor's live preview.
 *
 * Mirrors the backend's arithmetic (including clamping "the 31st" to shorter
 * months) but only ever in the viewer's own timezone, which is the only zone
 * the editor can produce. DST is handled implicitly: setting hours on a local
 * `Date` resolves through the platform's own zone rules.
 */
export function nextOccurrences(
  draft: RecurrenceDraft,
  count: number,
  now: Date = new Date(),
): Date[] {
  if (draftError(draft, now)) return [];
  if (draft.kind === "once") return [draft.runAt];
  if (draft.kind === "interval") {
    const step = draftIntervalSeconds(draft) * 1000;
    return Array.from(
      { length: count },
      (_, index) => new Date(now.getTime() + step * (index + 1)),
    );
  }

  const { hours, minutes } = parseTimeOfDay(draft.timeOfDay);
  const found: Date[] = [];
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  // Two months of headroom: the widest rule (monthly) matches at most once
  // every 31 days, so this cannot miss a match that exists.
  for (let day = 0; day < 62 && found.length < count; day += 1) {
    const candidate = new Date(cursor);
    candidate.setDate(cursor.getDate() + day);
    if (!dayMatches(draft, candidate)) continue;
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() > now.getTime()) found.push(candidate);
  }
  return found;
}

function dayMatches(draft: RecurrenceDraft, date: Date): boolean {
  if (draft.kind === "daily") return true;
  if (draft.kind === "weekly") return draft.weekdays.includes(isoWeekday(date));
  if (draft.kind === "monthly") {
    return date.getDate() === Math.min(draft.dayOfMonth, lastDayOfMonth(date));
  }
  return false;
}

function lastDayOfMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}
