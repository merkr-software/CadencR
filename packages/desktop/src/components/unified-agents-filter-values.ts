// Shared value helpers for the unified-agents filter language. Extracted so
// `UnifiedAgentsFilterLanguage.ts` stays within the file-size budget.

/** Split a filter value on top-level `|`, keeping quoted segments intact. */
export function splitFilterValues(value: string): string[] {
  const values: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of value.split("")) {
    if (isQuote(char)) {
      quote = quote === null ? char : quote === char ? null : quote;
      current += char;
    } else if (char === "|" && quote === null) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

export function firstFilterValue(value: string): string {
  return splitFilterValues(value)[0] ?? "";
}

export function normalizeFilterValue(value: string): string {
  return value.trim().replace(/^["“”]|["“”]$/g, "");
}

export function quoteFilterValue(value: string): string {
  return /[\s|:"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/** Treat a filter value as the affirmative side of a boolean toggle (`/pin:`).
 *  An empty value (bare `/pin:`) counts as `true` so the filter is easy to type. */
export function isTruthyFilterValue(value: string): boolean {
  const normalized = normalizeFilterValue(value).toLowerCase();
  return ["", "true", "1"].includes(normalized);
}

/** Normalize each value and dedupe case-insensitively, keeping first-seen
 *  casing and dropping empties. Shared by the parser, persistence, and the
 *  per-card exclude action so the "excluded titles" invariant lives once. */
export function dedupeTitles(
  values: string[],
  normalize: (value: string) => string = (value) => value.trim(),
): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const title = normalize(value);
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

export function isQuote(char: string): boolean {
  return char === '"' || char === "“" || char === "”";
}

export function isWhitespace(char: string): boolean {
  return char.length > 0 && /\s/.test(char);
}
