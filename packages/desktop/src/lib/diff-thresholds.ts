/**
 * Single source of truth for "what counts as a huge file in the git diff".
 *
 * Above this byte size, CodeMirror's synchronous Myers diff stops being
 * imperceptible — on Apple Silicon a 200 KB code-shaped file already takes
 * ~150 ms. Past that we render a placeholder ("Display diff" button) instead
 * of letting the main thread freeze. Mirrored on the backend
 * (`packages/service/src/domain/git/file_size.rs::LARGE_FILE_BYTES`) — keep
 * the two in sync.
 */
export const LARGE_DIFF_BYTES = 200_000;

/**
 * Cap on how many changed lines (additions + deletions, parsed from the
 * unified-diff hunks) we'll try to render inline. Past this, CodeMirror's
 * synchronous Myers diff stalls the main thread for hundreds of ms even on
 * files that fit comfortably under {@link LARGE_DIFF_BYTES} — for example
 * a hand-maintained `api/generated/index.ts` rewrite. Available from
 * `fileMeta` before the file content has been fetched, so we can decide to
 * show the placeholder before any heavy work runs.
 */
export const LARGE_DIFF_LINES = 1_500;

const utf8Encoder = new TextEncoder();

/** Return the encoded UTF-8 byte length used by backend size thresholds. */
export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

/**
 * True when either side's byte size is large enough that auto-rendering
 * would jank the UI.
 */
export function isLargeDiff(oldLen: number, newLen: number): boolean {
  return Math.max(oldLen, newLen) >= LARGE_DIFF_BYTES;
}

/**
 * True when the unified-diff hunks already contain enough changed lines to
 * jank CodeMirror, regardless of the underlying file size.
 */
export function isLargeDiffByLines(additions: number, deletions: number): boolean {
  return additions + deletions >= LARGE_DIFF_LINES;
}

/** Pretty-print a byte count using KB / MB units. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
