/**
 * Pure diff → per-line gutter-marker computation.
 *
 * Given the baseline (HEAD) text and the current buffer text, derive one marker
 * per changed line of the CURRENT document:
 *
 *   – "added"    one or more whole new lines that do not exist in the baseline
 *   – "modified" a line whose content changed in place
 *   – "deleted"  lines removed from the baseline, rendered as a single marker
 *                on the current line that now sits where they were
 *
 * The diff runs on LINES, like `git diff` hunks (`@@ -a,b +c,d @@`): each
 * distinct line is encoded as one character and the encoded strings go through
 * `@codemirror/merge`'s `diff`, so every change is a whole-line range by
 * construction. A character-level diff cannot be classified reliably:
 * `presentableDiff` slides a removed line to a word boundary (`x}\n  ` instead
 * of `  x}\n`) and folds short unchanged runs into the change, so a pure line
 * deletion or insertion reads as an edit inside a surviving line.
 *
 * This runs on every keystroke, so the lines both texts share at the start and
 * at the end are skipped with a character scan and only the region between
 * them is split and encoded.
 *
 * Kept pure and free of CodeMirror view types so it can be unit-tested with
 * plain strings. `git-gutter-extension.ts` turns the result into a CM6
 * `GutterMarker` set.
 */
import { diff, type DiffConfig } from "@codemirror/merge";

export type GitMarkerKind = "added" | "modified" | "deleted";

export interface GitLineMarker {
  /** 1-based line number in the CURRENT document. */
  line: number;
  kind: GitMarkerKind;
}

/**
 * Line codes are single UTF-16 code units outside the surrogate range, so the
 * encoded strings never contain a pair the diff could split.
 */
const SURROGATE_START = 0xd800;
const SURROGATE_COUNT = 0x800;
const MAX_LINE_CODES = 0x10000 - SURROGATE_COUNT;

const NEWLINE = 10;

/**
 * Bounds the diff of a heavily rewritten buffer. `scanLimit` counts changed
 * LINES: high enough that a few thousand scattered edits (a rename) stay
 * line-exact, while reindenting a whole 1 MB file costs some 60–80 ms. No
 * `timeout`: a time-based cutoff would make the markers depend on machine load.
 */
const LINE_DIFF_CONFIG: DiffConfig = { scanLimit: 5_000 };

/** The lines that differ between the two texts, past their shared prefix and suffix. */
interface ChangedRegion {
  /** Lines both texts share before the region. */
  lineOffset: number;
  baselineLines: string[];
  currentLines: string[];
  /** Whether lines both texts share follow the region. */
  hasSuffix: boolean;
}

/** The lines of `text[from, to)`; a region ending before EOF ends on a line break. */
function regionLines(text: string, from: number, to: number): string[] {
  const lines = text.slice(from, to).split("\n");
  // The `\n` closing the region's last line is followed by the shared suffix,
  // not by a line of the region.
  if (to < text.length) lines.pop();
  return lines;
}

/**
 * Characters compared at once while skipping the shared prefix and suffix: a
 * native string comparison per block instead of a JS loop per character, which
 * dominated the per-keystroke cost on large files.
 */
const SCAN_BLOCK = 512;

function sharedPrefixLength(a: string, b: string, limit: number): number {
  let length = 0;
  while (
    length + SCAN_BLOCK <= limit &&
    a.slice(length, length + SCAN_BLOCK) === b.slice(length, length + SCAN_BLOCK)
  ) {
    length += SCAN_BLOCK;
  }
  while (length < limit && a.charCodeAt(length) === b.charCodeAt(length)) length++;
  return length;
}

function sharedSuffixLength(a: string, b: string, limit: number): number {
  let length = 0;
  while (
    length + SCAN_BLOCK <= limit &&
    a.slice(a.length - length - SCAN_BLOCK, a.length - length) ===
      b.slice(b.length - length - SCAN_BLOCK, b.length - length)
  ) {
    length += SCAN_BLOCK;
  }
  while (
    length < limit &&
    a.charCodeAt(a.length - 1 - length) === b.charCodeAt(b.length - 1 - length)
  ) {
    length++;
  }
  return length;
}

function changedRegion(baseline: string, current: string): ChangedRegion {
  const shorter = Math.min(baseline.length, current.length);
  const prefix = sharedPrefixLength(baseline, current, shorter);
  // Back to the start of the line the first difference is on.
  const start = prefix === 0 ? 0 : baseline.lastIndexOf("\n", prefix - 1) + 1;
  let lineOffset = 0;
  for (
    let at = baseline.indexOf("\n");
    at !== -1 && at < start;
    at = baseline.indexOf("\n", at + 1)
  ) {
    lineOffset++;
  }

  let suffix = sharedSuffixLength(baseline, current, shorter - start);
  // The shared suffix must start a line in both texts: keep it whole when it
  // already does, else drop it up to and including its first line break.
  const endA = baseline.length - suffix;
  const endB = current.length - suffix;
  const startsLine = (text: string, end: number): boolean =>
    end === start || text.charCodeAt(end - 1) === NEWLINE;
  if (suffix > 0 && !(startsLine(baseline, endA) && startsLine(current, endB))) {
    const breakAt = baseline.indexOf("\n", endA);
    suffix = breakAt === -1 ? 0 : baseline.length - breakAt - 1;
  }

  return {
    lineOffset,
    baselineLines: regionLines(baseline, start, baseline.length - suffix),
    currentLines: regionLines(current, start, current.length - suffix),
    hasSuffix: suffix > 0,
  };
}

/**
 * Encode both line lists as one character per line, equal lines sharing a
 * code. `null` when they hold more distinct lines than there are codes, which
 * a rewrite of a long file of short distinct lines (data, word lists) reaches.
 */
function encodeLines(a: readonly string[], b: readonly string[]): [string, string] | null {
  const codes = new Map<string, string>();
  const encode = (lines: readonly string[]): string | null => {
    let encoded = "";
    for (const line of lines) {
      let code = codes.get(line);
      if (code === undefined) {
        if (codes.size >= MAX_LINE_CODES) return null;
        const id = codes.size;
        code = String.fromCharCode(id < SURROGATE_START ? id : id + SURROGATE_COUNT);
        codes.set(line, code);
      }
      encoded += code;
    }
    return encoded;
  };
  const encodedA = encode(a);
  const encodedB = encodedA === null ? null : encode(b);
  return encodedA === null || encodedB === null ? null : [encodedA, encodedB];
}

/**
 * Diff `current` against `baseline` line by line and return the markers,
 * sorted by line.
 *
 * @param baseline  file content at HEAD
 * @param current   current buffer content
 */
export function computeGitLineMarkers(baseline: string, current: string): GitLineMarker[] {
  if (baseline === current) return [];
  const region = changedRegion(baseline, current);
  const { lineOffset, currentLines } = region;
  // Without a shared suffix the region runs to the end of the file, so its
  // last line is the document's last line.
  const lastLine = region.hasSuffix ? Infinity : lineOffset + currentLines.length;
  const deletedAt = (index: number): GitLineMarker => ({
    line: Math.min(lineOffset + index + 1, lastLine),
    kind: "deleted",
  });

  const encoded = encodeLines(region.baselineLines, currentLines);
  if (!encoded) {
    // Too many distinct lines to diff: still show that the region changed.
    if (currentLines.length === 0) return [deletedAt(0)];
    return currentLines.map((_, index) => ({ line: lineOffset + index + 1, kind: "modified" }));
  }

  const markers: GitLineMarker[] = [];
  // Offsets in the encoded strings are 0-based line indices into the region.
  for (const change of diff(encoded[0], encoded[1], LINE_DIFF_CONFIG)) {
    const removed = change.toA > change.fromA;
    const inserted = change.toB > change.fromB;
    if (!inserted) {
      if (!removed) continue;
      // Anchor on the line now sitting where the removed ones were; a deletion
      // at the end of the file anchors on the last remaining line, which keeps
      // its marker when it was itself added or modified.
      const marker = deletedAt(change.fromB);
      if (markers.at(-1)?.line !== marker.line) markers.push(marker);
      continue;
    }
    // Whole lines replaced in place → modified; with nothing removed → added.
    const kind: GitMarkerKind = removed ? "modified" : "added";
    for (let index = change.fromB; index < change.toB; index++) {
      markers.push({ line: lineOffset + index + 1, kind });
    }
  }
  return markers;
}
