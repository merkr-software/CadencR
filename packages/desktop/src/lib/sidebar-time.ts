import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { formatClock } from "@/lib/format-clock";
import { isSameDay, isSameYear } from "date-fns";
import { translateUi, uiI18n } from "@/lib/i18n/ui";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

// Cache by effective locale: every visible row formats its time again each minute.
function makeTimeFormats(locale: string) {
  return {
    full: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    shortDate: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    dateWithYear: new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  };
}

const timeFormats = new Map<string, ReturnType<typeof makeTimeFormats>>();

function sidebarTimeFormats(locale: string) {
  const existing = timeFormats.get(locale);
  if (existing) return existing;
  const formats = makeTimeFormats(locale);
  timeFormats.set(locale, formats);
  return formats;
}

export function isSidebarTimeNow(date: Date, now: number): boolean {
  return now - date.getTime() < MINUTE_MS;
}

/**
 * A sidebar-width relative time: `now`, `5m`, `3h`, `2d`, `3w`, `2mo`, `1y`.
 * Never a date: at most four characters, so the title keeps its room.
 */
export function formatSidebarRelativeTime(date: Date, now: number): string {
  const elapsed = Math.max(0, now - date.getTime());
  if (isSidebarTimeNow(date, now)) return translateUi("sidebar.time.now", "now");
  if (elapsed < HOUR_MS)
    return translateUi("sidebar.time.minutes", "{{count}}m", {
      count: Math.floor(elapsed / MINUTE_MS),
    });
  if (elapsed < DAY_MS)
    return translateUi("sidebar.time.hours", "{{count}}h", {
      count: Math.floor(elapsed / HOUR_MS),
    });
  if (elapsed < WEEK_MS)
    return translateUi("sidebar.time.days", "{{count}}d", { count: Math.floor(elapsed / DAY_MS) });
  if (elapsed < 5 * WEEK_MS)
    return translateUi("sidebar.time.weeks", "{{count}}w", {
      count: Math.floor(elapsed / WEEK_MS),
    });
  if (elapsed < YEAR_MS)
    return translateUi("sidebar.time.months", "{{count}}mo", {
      count: Math.max(1, Math.floor(elapsed / MONTH_MS)),
    });
  return translateUi("sidebar.time.years", "{{count}}y", { count: Math.floor(elapsed / YEAR_MS) });
}

/** A sidebar-width absolute time: the clock time today, else the date. */
export function formatSidebarAbsoluteTime(date: Date, now: number): string {
  const locale = formattingLocale(uiI18n.language);
  if (isSameDay(date, now)) return formatClock(date, locale);
  const formats = sidebarTimeFormats(locale);
  return (isSameYear(date, now) ? formats.shortDate : formats.dateWithYear).format(date);
}

/** The full date and time, for the label's tooltip. */
export function formatSidebarFullTime(date: Date): string {
  return sidebarTimeFormats(formattingLocale(uiI18n.language)).full.format(date);
}
