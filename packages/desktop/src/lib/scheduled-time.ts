/**
 * Helpers for the scheduled-message date/time picker.
 *
 * All scheduling is done in the viewer's local timezone: the picker works on
 * local-time `Date`s and we convert to a UTC ISO string only when talking to
 * the backend. Display likewise renders in local time. Nothing here assumes UTC
 * except the wire format.
 */
import { format, formatDistanceToNowStrict, isToday, isTomorrow } from "date-fns";

export interface SchedulePreset {
  label: string;
  /** Returns the target Date relative to `now`. */
  resolve: (now: Date) => Date;
}

/** At/after `hour:00` today, else the same time tomorrow. */
function nextAtHour(now: Date, hour: number): Date {
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { label: "In 1 hour", resolve: (now) => new Date(now.getTime() + 60 * 60_000) },
  { label: "In 3 hours", resolve: (now) => new Date(now.getTime() + 3 * 60 * 60_000) },
  { label: "This evening", resolve: (now) => nextAtHour(now, 18) },
  { label: "Tomorrow 9 AM", resolve: (now) => nextAtHour(now, 9) },
];

/** The viewer's IANA timezone, e.g. `Europe/Paris`. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "local time";
  }
}

/** A short absolute label in local time, e.g. `Today at 3:00 PM`. */
export function formatScheduledAbsolute(date: Date): string {
  const time = format(date, "h:mm a");
  if (isToday(date)) return `Today at ${time}`;
  if (isTomorrow(date)) return `Tomorrow at ${time}`;
  return `${format(date, "EEE, MMM d")} at ${time}`;
}

/** A relative label, e.g. `in 2 hours`. */
export function formatScheduledRelative(date: Date): string {
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

/**
 * Delay (ms) until the next countdown re-render, or `null` to stop. Tightens to
 * 1s inside the final minute (where the label counts down in seconds) and
 * relaxes to 30s further out; stops once the target is ~1s past due.
 */
export function nextCountdownDelay(msUntil: number): number | null {
  if (msUntil <= -1_000) return null;
  return msUntil <= 60_000 ? 1_000 : 30_000;
}
