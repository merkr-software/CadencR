const clocks = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock time in the user's locale, shared by sidebar and Notch. */
export function formatClock(time: number | Date, locale: string): string {
  let formatter = clocks.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
    clocks.set(locale, formatter);
  }
  return formatter.format(time);
}
