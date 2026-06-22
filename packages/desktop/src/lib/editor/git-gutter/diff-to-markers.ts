/**
 * Pure diff → per-line gutter-marker computation.
 *
 * Given the baseline (HEAD) text and the current buffer text, plus the
 * character-level `Change[]` that `@codemirror/merge`'s `presentableDiff`
 * produces, derive one marker per changed line of the CURRENT document:
 *
 *   – "added"    one or more whole new lines that do not exist in the baseline
 *   – "modified" a line whose content changed in place
 *   – "deleted"  lines removed from the baseline, rendered as a single marker
 *                on the current line that now sits where they were
 *
 * Char-offset diffs anchor insertions/deletions at arbitrary points inside a
 * line (e.g. just before a `\n`), which makes a naive per-offset classification
 * mislabel whole-line inserts as modifications. To avoid that we EXPAND every
 * change to line boundaries on both the baseline (A) and current (B) sides —
 * the same normalization CodeMirror's own merge `Chunk` uses — and classify
 * from the resulting line spans.
 *
 * Kept pure and free of CodeMirror view types so it can be unit-tested with
 * plain strings. `git-gutter-extension.ts` turns the result into a CM6
 * `GutterMarker` set.
 */
import type { Change } from "@codemirror/merge";

export type GitMarkerKind = "added" | "modified" | "deleted";

export interface GitLineMarker {
  /** 1-based line number in the CURRENT document. */
  line: number;
  kind: GitMarkerKind;
}

/** Pre-computed line-start offsets + lookups for one text. */
interface LineIndex {
  /** 1-based line number containing `offset`. */
  lineAt(offset: number): number;
  /** Total number of lines. */
  count: number;
}

function buildLineIndex(text: string): LineIndex {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return { lineAt, count: starts.length };
}

/**
 * Convert the character-level diff into per-line markers on the current doc.
 *
 * @param baseline  file content at HEAD
 * @param current   current buffer content
 * @param changes   `presentableDiff(baseline, current)` output (offsets into
 *                  `baseline` for the A side and `current` for the B side)
 */
export function computeGitLineMarkers(
  baseline: string,
  current: string,
  changes: readonly Change[],
): GitLineMarker[] {
  const b = buildLineIndex(current);
  // Highest-priority kind wins per line: modified > added/deleted.
  const byLine = new Map<number, GitMarkerKind>();

  const promote = (line: number, kind: GitMarkerKind): void => {
    if (byLine.get(line) === "modified") return;
    byLine.set(line, kind);
  };

  for (const change of changes) {
    const hasInsertion = change.toB > change.fromB;
    const hasDeletion = change.toA > change.fromA;
    if (!hasInsertion && !hasDeletion) continue;

    // Line spans touched on each side, expanded to whole lines. `endsAtBoundary`
    // tracks whether the change ends exactly at a line start; when it does, the
    // final line is untouched (the change sits entirely on earlier lines), so we
    // exclude it to avoid bleeding the marker onto a line that only shifted.
    const firstB = b.lineAt(change.fromB);
    const lastBRaw = b.lineAt(change.toB);
    const bEndsAtBoundary = change.toB > change.fromB && isLineStart(current, change.toB);
    const lastB = bEndsAtBoundary ? Math.max(firstB, lastBRaw - 1) : lastBRaw;
    const bWholeLines = hasInsertion && isLineStart(current, change.fromB) && bEndsAtBoundary;

    const aEndsAtBoundary = change.toA > change.fromA && isLineStart(baseline, change.toA);
    const aWholeLines = hasDeletion && isLineStart(baseline, change.fromA) && aEndsAtBoundary;

    if (hasInsertion) {
      // Whole-line insertion with no baseline lines consumed → added.
      // Anything that touches a pre-existing line (partial edit, or paired with
      // a deletion) → modified.
      const kind: GitMarkerKind = hasDeletion || !bWholeLines ? "modified" : "added";
      for (let line = firstB; line <= lastB; line++) promote(line, kind);
    } else if (aWholeLines) {
      // Whole baseline lines removed with no replacement → deleted marker on the
      // current line that now occupies the deletion point.
      promote(Math.min(firstB, b.count), "deleted");
    } else {
      // Partial deletion inside a surviving line → that line was modified.
      promote(Math.min(firstB, b.count), "modified");
    }
  }

  return [...byLine.entries()]
    .map(([line, kind]): GitLineMarker => ({ line, kind }))
    .sort((x, y) => x.line - y.line);
}

/** True when `offset` sits at the start of a line (line boundary) in `text`. */
function isLineStart(text: string, offset: number): boolean {
  return offset === 0 || text.charCodeAt(offset - 1) === 10;
}
