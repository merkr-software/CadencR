const numbers = new Map<string, Intl.NumberFormat>();
const paddedNumbers = new Map<string, Intl.NumberFormat>();

export function formatExactNumber(
  value: number,
  locale: string,
  minimumIntegerDigits: 1 | 2 = 1,
): string {
  const formats = minimumIntegerDigits === 2 ? paddedNumbers : numbers;
  let formatter = formats.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { minimumIntegerDigits });
    formats.set(locale, formatter);
  }
  return formatter.format(value);
}

const percentFormats = new Map<string, Intl.NumberFormat>();

/** A ratio of 1 represents 100% in every display. */
export function formatPercent(ratio: number, locale: string): string {
  let format = percentFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
    percentFormats.set(locale, format);
  }
  return format.format(ratio);
}
