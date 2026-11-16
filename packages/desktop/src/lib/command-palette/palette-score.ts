/**
 * How well a palette entry matches what the user typed. Words match in any
 * order; each one must land on a word start, inside a word, on the initials of
 * consecutive words, or (long words only) as a tight subsequence. Case and
 * accents never matter. Nothing else matches: a scatter of letters across a
 * title ("git" in "Global Settings") is noise, not a result.
 */

export type MatchRange = readonly [start: number, end: number];

export interface ScoreField {
  text: string;
  /** How much a match here counts (the title is 1). */
  weight: number;
}

export interface PaletteMatch {
  score: number;
  /** Ranges of the first field's text to highlight. */
  ranges: MatchRange[];
}

interface TokenMatch {
  score: number;
  ranges: MatchRange[];
}

const WORD_START = 1;
const INSIDE_WORD = 0.55;
const INITIALS = 0.75;
const SUBSEQUENCE = 0.3;
const SUBSEQUENCE_MIN_LENGTH = 3;
const SEPARATOR = /[^\p{L}\p{N}]/u;

/**
 * Lowercased, accent-free copy of `text` with exactly one character per UTF-16
 * unit, so an index in it is an index in the original.
 */
export function foldText(text: string): string {
  let folded = "";
  for (let index = 0; index < text.length; index += 1) {
    const unit = text[index] ?? "";
    const base = unit.normalize("NFD")[0] ?? unit;
    folded += (base.toLowerCase()[0] ?? base).replace("’", "'");
  }
  return folded;
}

/** The words of a query, folded; empty when there is nothing to match. */
export function queryTokens(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean);
}

function isAlphanumeric(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/** Indexes where a word starts: after a separator, a camelCase hump, or a digit run. */
function wordStarts(text: string): number[] {
  const starts: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!isAlphanumeric(char)) continue;
    const previous = text[index - 1];
    const hump = previous !== undefined && /\p{Ll}/u.test(previous) && /\p{Lu}/u.test(char ?? "");
    const digitEdge = previous !== undefined && /\d/.test(previous) !== /\d/.test(char ?? "");
    if (!isAlphanumeric(previous) || hump || digitEdge) starts.push(index);
  }
  return starts;
}

interface PreparedText {
  folded: string;
  starts: number[];
  startSet: Set<number>;
}

/**
 * Folding and word starts per distinct text, kept across keystrokes: ranking
 * runs over every conversation on each one, and the texts rarely change.
 */
const prepared = new Map<string, PreparedText>();
const PREPARED_LIMIT = 20_000;

function prepare(text: string): PreparedText {
  let entry = prepared.get(text);
  if (!entry) {
    if (prepared.size >= PREPARED_LIMIT) prepared.clear();
    const starts = wordStarts(text);
    entry = { folded: foldText(text), starts, startSet: new Set(starts) };
    prepared.set(text, entry);
  }
  return entry;
}

function substringMatch(
  token: string,
  folded: string,
  starts: ReadonlySet<number>,
): TokenMatch | null {
  let first = -1;
  for (let at = folded.indexOf(token); at !== -1; at = folded.indexOf(token, at + 1)) {
    if (starts.has(at)) return { score: WORD_START, ranges: [[at, at + token.length]] };
    if (first === -1) first = at;
  }
  return first === -1 ? null : { score: INSIDE_WORD, ranges: [[first, first + token.length]] };
}

/** "cpn" → Command Palette Navigation: each letter the start of the next word. */
function initialsMatch(
  token: string,
  folded: string,
  starts: readonly number[],
): TokenMatch | null {
  if (token.length < 2) return null;
  for (let begin = 0; begin + token.length <= starts.length; begin += 1) {
    const window = starts.slice(begin, begin + token.length);
    if (window.every((start, offset) => folded[start] === token[offset])) {
      return { score: INITIALS, ranges: window.map((start) => [start, start + 1] as const) };
    }
  }
  return null;
}

/**
 * An abbreviation or a slip ("cmd" → Command, "navgation"): letters in order,
 * starting a word and staying inside it, gaps bounded.
 */
function subsequenceMatch(
  token: string,
  folded: string,
  starts: readonly number[],
): TokenMatch | null {
  if (token.length < SUBSEQUENCE_MIN_LENGTH) return null;
  const maxGap = token.length * 2;
  for (const start of starts) {
    if (folded[start] !== token[0]) continue;
    const ranges: MatchRange[] = [[start, start + 1]];
    let cursor = start + 1;
    let gaps = 0;
    for (const char of token.slice(1)) {
      const at = folded.indexOf(char, cursor);
      // Skipping over a space or a separator would leave the word.
      if (at === -1 || SEPARATOR.test(folded.slice(cursor, at))) break;
      gaps += at - cursor;
      ranges.push([at, at + 1]);
      cursor = at + 1;
    }
    if (ranges.length === token.length && gaps <= maxGap) return { score: SUBSEQUENCE, ranges };
  }
  return null;
}

function matchToken(token: string, { folded, starts, startSet }: PreparedText): TokenMatch | null {
  return (
    substringMatch(token, folded, startSet) ??
    initialsMatch(token, folded, starts) ??
    subsequenceMatch(token, folded, starts)
  );
}

function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Scores `tokens` against `fields` (the first one is the title, the only one
 * highlighted). Every token must match some field, else `null`. On top of the
 * average token score: the whole query as one run in the title, at its start,
 * all words in the title, and a shorter title.
 */
export function scoreFields(
  tokens: readonly string[],
  fields: readonly ScoreField[],
): PaletteMatch | null {
  if (tokens.length === 0) return { score: 0, ranges: [] };
  const texts = fields.map((field) => ({ ...field, ...prepare(field.text) }));
  let total = 0;
  let inTitle = 0;
  const ranges: MatchRange[] = [];
  for (const token of tokens) {
    let best = 0;
    texts.forEach((field, index) => {
      const match = matchToken(token, field);
      if (!match) return;
      best = Math.max(best, match.score * field.weight);
      if (index === 0) {
        inTitle += 1;
        ranges.push(...match.ranges);
      }
    });
    if (best === 0) return null;
    total += best;
  }
  const title = texts[0];
  let score = total / tokens.length;
  if (title) {
    const phrase = title.folded.indexOf(tokens.join(" "));
    if (tokens.length > 1 && phrase !== -1) score += 0.3;
    if (title.folded.startsWith(tokens[0] ?? "")) score += 0.2;
    if (inTitle === tokens.length) score += 0.15;
    score += 0.1 * (1 - Math.min(1, title.text.length / 80));
  }
  return { score, ranges: mergeRanges(ranges) };
}
