import { format, isSameDay, isSameYear } from "date-fns";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

// Built once: every visible row formats its time again each minute.
const CLOCK_TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const FULL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * A sidebar-width relative time: `now`, `5m`, `3h`, `2d`, `3w`, `2mo`, `1y`.
 * Never a date: at most four characters, so the title keeps its room.
 */
export function formatSidebarRelativeTime(date: Date, now: number): string {
  const elapsed = Math.max(0, now - date.getTime());
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
  if (elapsed < 5 * WEEK_MS) return `${Math.floor(elapsed / WEEK_MS)}w`;
  if (elapsed < YEAR_MS) return `${Math.max(1, Math.floor(elapsed / MONTH_MS))}mo`;
  return `${Math.floor(elapsed / YEAR_MS)}y`;
}

/** A sidebar-width absolute time: the clock time today, else the date. */
export function formatSidebarAbsoluteTime(date: Date, now: number): string {
  if (isSameDay(date, now)) {
    return CLOCK_TIME.format(date);
  }
  return format(date, isSameYear(date, now) ? "MMM d" : "MMM d, yyyy");
}

/** The full date and time, for the label's tooltip. */
export function formatSidebarFullTime(date: Date): string {
  return FULL_TIME.format(date);
}
