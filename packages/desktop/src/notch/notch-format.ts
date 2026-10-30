const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Wall-clock time in the user's locale: "9:30 PM", "21:30". */
export function formatClock(epochMs: number): string {
  return CLOCK.format(epochMs);
}

/** Compact age of a finished turn: "now", "4m", "2h", "3d". */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
