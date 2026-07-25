/**
 * Human-readable renderings of a schedule.
 *
 * A schedule is only useful if the user can read its rule at a glance — "Every
 * weekday at 9:00 AM" rather than a row of fields to reassemble mentally. All
 * absolute times render in the viewer's local timezone; the wire is UTC.
 */
import { format, formatDistanceToNowStrict, isToday, isTomorrow } from "date-fns";
import type { Recurrence, Schedule } from "@/api/generated";
import { parseTimeOfDay } from "./recurrence";

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 7];

/** `HH:MM` rendered in the viewer's locale, e.g. `9:00 AM`. */
export function formatTimeOfDay(timeOfDay: string): string {
  const { hours, minutes } = parseTimeOfDay(timeOfDay);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return format(date, "h:mm a");
}

function formatWeekdays(weekdays: number[]): string {
  const sorted = [...weekdays].sort((a, b) => a - b);
  if (sorted.length === 7) return "every day";
  if (sameDays(sorted, WEEKDAYS)) return "weekdays";
  if (sameDays(sorted, WEEKEND)) return "weekends";
  return sorted.map((day) => WEEKDAY_NAMES[day - 1]).join(", ");
}

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((day, index) => day === b[index]);
}

function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

function ordinal(day: number): string {
  const suffix =
    day % 100 >= 11 && day % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${suffix}`;
}

/** The rule as a sentence, e.g. `Every weekday at 9:00 AM`. */
export function describeRecurrence(recurrence: Recurrence): string {
  switch (recurrence.kind) {
    case "once":
      return "Once";
    case "interval":
      return `Every ${formatInterval(recurrence.interval_seconds ?? 60)}`;
    case "daily":
      return `Every day at ${formatTimeOfDay(recurrence.time_of_day ?? "09:00")}`;
    case "weekly":
      return `Every ${formatWeekdays(recurrence.weekdays ?? [])} at ${formatTimeOfDay(
        recurrence.time_of_day ?? "09:00",
      )}`;
    case "monthly":
      return `Monthly on the ${ordinal(recurrence.day_of_month ?? 1)} at ${formatTimeOfDay(
        recurrence.time_of_day ?? "09:00",
      )}`;
    default:
      return "Custom";
  }
}

/** A short absolute label in local time, e.g. `Today at 3:00 PM`. */
export function formatAbsolute(date: Date): string {
  const time = format(date, "h:mm a");
  if (isToday(date)) return `Today at ${time}`;
  if (isTomorrow(date)) return `Tomorrow at ${time}`;
  return `${format(date, "EEE, MMM d")} at ${time}`;
}

/** A relative label, e.g. `in 2 hours`. */
export function formatRelative(date: Date): string {
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

/** What the schedule targets, e.g. `New conversation in cadencr`. */
export function describeTarget(schedule: Schedule): string {
  if (schedule.target.kind === "new_conversation") {
    const project = schedule.context.project_name;
    return project ? `New conversation in ${project}` : "New conversation";
  }
  return schedule.context.feature_title ?? "A conversation";
}

/** First line of the prompt, clipped — what the run will actually send, which
 *  is how a schedule is recognized in a list of them. */
export function schedulePromptPreview(schedule: Schedule, maxLength = 120): string {
  const firstLine = schedule.prompt.trim().split("\n")[0].trim();
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength)}…` : firstLine;
}

/** The label a schedule is listed under. Falls back to its prompt's first line
 *  so an unnamed schedule is still identifiable at a glance. */
export function scheduleTitle(schedule: Schedule): string {
  const name = schedule.name?.trim();
  if (name) return name;
  return schedulePromptPreview(schedule, 80) || "Untitled schedule";
}

/**
 * Delay (ms) until the next countdown re-render, or `null` to stop. Tightens to
 * 1s inside the final minute and relaxes to 30s further out; stops once the
 * target is ~1s past due.
 */
export function nextCountdownDelay(msUntil: number): number | null {
  if (msUntil <= -1_000) return null;
  return msUntil <= 60_000 ? 1_000 : 30_000;
}
