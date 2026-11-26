import { formatExactNumber } from "@/lib/format-number";
import { dateLocale } from "@/lib/i18n/date-locale";
import type { UiTranslator } from "@/lib/i18n/ui";
import { translateUi, uiI18n } from "@/shared/ui-i18n";
import { format, formatDistanceToNowStrict, isToday } from "date-fns";

/**
 * Parse a UTC datetime string from SQLite.
 *
 * SQLite's `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` in UTC
 * but without a timezone suffix, so `new Date()` would misinterpret
 * it as local time. This helper appends `Z` when needed.
 */
export function parseUTCDateTime(value: string): Date {
  const normalized = value.replace(" ", "T");
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized);
  if (hasZone || /^\d{4}-\d{2}-\d{2}$/.test(normalized)) return new Date(normalized);
  return new Date(`${normalized}Z`);
}

/** Compact elapsed time for status surfaces that use different ranges. */
export function formatCompactAge(
  timestamp: number,
  t: UiTranslator,
  locale: string,
  { showSeconds = false, showDays = false }: { showSeconds?: boolean; showDays?: boolean },
): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    if (!showSeconds || seconds < 5) return t("common.time.justNow", "just now");
    return t("time.relative.secondsAgo", "{{number}}s ago", {
      number: formatExactNumber(seconds, locale),
    });
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return t("time.relative.minutesAgo", "{{number}} min ago", {
      number: formatExactNumber(minutes, locale),
    });

  const hours = Math.floor(minutes / 60);
  if (showDays && hours >= 24)
    return t("time.relative.daysAgo", "{{number}}d ago", {
      number: formatExactNumber(Math.floor(hours / 24), locale),
    });

  return t("time.relative.hoursAgo", "{{number}}h ago", {
    number: formatExactNumber(hours, locale),
  });
}

export function formatRelativeDistance(date: Date, language: string): string {
  return formatDistanceToNowStrict(date, {
    addSuffix: true,
    locale: dateLocale(language),
  });
}

/** "3 days ago"; the raw value when it does not parse, never a made-up date. */
export function formatAgo(iso?: string | null, language = uiI18n.language): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return Date.now() - date.getTime() < 60_000
    ? translateUi("common.time.justNow", "just now")
    : formatRelativeDistance(date, language);
}

/** A stream message's time: "14:05" today, "2026/10/20 14:05" before. */
export function formatStreamTimestamp(iso: string): string {
  const date = parseUTCDateTime(iso);
  if (isToday(date)) return format(date, "HH:mm");
  return format(date, "yyyy/MM/dd HH:mm");
}
