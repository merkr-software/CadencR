import { format, formatDistanceToNowStrict, isToday } from "date-fns";

/**
 * Parse a UTC datetime string from SQLite.
 *
 * SQLite's `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` in UTC
 * but without a timezone suffix, so `new Date()` would misinterpret
 * it as local time. This helper appends `Z` when needed.
 */
export function parseUTCDateTime(value: string): Date {
  if (/[Z+-]/.test(value.slice(-6))) return new Date(value);
  return new Date(value.replace(" ", "T") + "Z");
}

/** "3 days ago"; the raw value when it does not parse, never a made-up date. */
export function formatAgo(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return Date.now() - date.getTime() < 60_000
    ? "just now"
    : formatDistanceToNowStrict(date, { addSuffix: true });
}

/** A stream message's time: "14:05" today, "2026/10/20 14:05" before. */
export function formatStreamTimestamp(iso: string): string {
  const date = parseUTCDateTime(iso);
  if (isToday(date)) return format(date, "HH:mm");
  return format(date, "yyyy/MM/dd HH:mm");
}
