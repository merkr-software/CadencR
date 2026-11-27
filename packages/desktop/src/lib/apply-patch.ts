import { stringArg } from "@/lib/tool-args";

export interface ApplyPatchChange {
  kind: "add" | "update" | "delete";
  filePath: string;
  moveTo?: string;
  addedLines: string[];
  removedLines: string[];
}

export interface ApplyPatchPreview {
  filePath: string;
  oldContent: string;
  newContent: string;
  /** Set only for a placeholder supplied by Cadencr, never for literal patch content. */
  emptyFileAction?: "created" | "deleted";
}

const PATCH_TEXT_KEYS = ["patch_text", "patchText", "input"] as const;
const ADD_PREFIX = "*** Add File: ";
const UPDATE_PREFIX = "*** Update File: ";
const DELETE_PREFIX = "*** Delete File: ";
const MOVE_PREFIX = "*** Move to: ";
const CREATED_FILE_PLACEHOLDER = "(file created)";
const DELETED_FILE_PLACEHOLDER = "(file deleted)";

export function extractApplyPatchText(args: Record<string, unknown>): string | undefined {
  return stringArg(args, ...PATCH_TEXT_KEYS);
}

export function isApplyPatchToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return toolName === "ApplyPatch" || toolName === "apply_patch" || toolName === "Patch";
}

export function parseApplyPatchChanges(patchText: string): ApplyPatchChange[] {
  const changes: ApplyPatchChange[] = [];
  let current: ApplyPatchChange | null = null;

  for (const line of patchText.split("\n")) {
    if (line === "*** End Patch") break;
    if (line.startsWith(ADD_PREFIX)) {
      current = {
        kind: "add",
        filePath: line.slice(ADD_PREFIX.length),
        addedLines: [],
        removedLines: [],
      };
      changes.push(current);
      continue;
    }
    if (line.startsWith(UPDATE_PREFIX)) {
      current = {
        kind: "update",
        filePath: line.slice(UPDATE_PREFIX.length),
        addedLines: [],
        removedLines: [],
      };
      changes.push(current);
      continue;
    }
    if (line.startsWith(DELETE_PREFIX)) {
      current = {
        kind: "delete",
        filePath: line.slice(DELETE_PREFIX.length),
        addedLines: [],
        removedLines: [],
      };
      changes.push(current);
      continue;
    }
    if (line.startsWith(MOVE_PREFIX)) {
      if (current) current.moveTo = line.slice(MOVE_PREFIX.length);
      continue;
    }
    if (!current || line === "*** End of File" || line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.addedLines.push(line.slice(1));
    if (line.startsWith("-")) current.removedLines.push(line.slice(1));
  }

  return changes;
}

export function extractApplyPatchPrimaryPath(args: Record<string, unknown>): string | undefined {
  const patchText = extractApplyPatchText(args);
  if (!patchText) return undefined;
  const first = parseApplyPatchChanges(patchText)[0];
  if (!first) return undefined;
  return first.moveTo ?? first.filePath;
}

export function extractApplyPatchPreview(args: Record<string, unknown>): ApplyPatchPreview | null {
  const patchText = extractApplyPatchText(args);
  if (!patchText) return null;
  return previewFromPatchText(patchText);
}

export function extractApplyPatchPreviews(args: Record<string, unknown>): ApplyPatchPreview[] {
  const patchText = extractApplyPatchText(args);
  if (!patchText) return [];
  return previewsFromPatchText(patchText);
}

/**
 * Build an ApplyPatch preview from a (possibly truncated) raw JSON string.
 *
 * Streaming `partial_json` for ApplyPatch is `{"patch_text": "<huge string>"}`,
 * which only becomes valid JSON at the very last delta. The shared
 * `latestValidJsonSnapshot` helper therefore can't surface a preview during
 * the stream — the diff only "pops in" at the end.
 *
 * This tolerant extractor scans for `"patch_text":"` (or `"patchText":"`) and
 * decodes JSON-string escapes until it hits the first unescaped `"` or end of
 * input. The decoded substring is fed to the existing `parseApplyPatchChanges`
 * (which already tolerates a missing `*** End Patch` trailer), so the diff
 * grows incrementally as more bytes stream in.
 */
export function extractApplyPatchPreviewPartial(rawContent: string): ApplyPatchPreview | null {
  const patchText = extractPatchTextFromRawContent(rawContent);
  if (patchText === undefined) return null;
  return previewFromPatchText(patchText);
}

export function extractApplyPatchPreviewsPartial(rawContent: string): ApplyPatchPreview[] {
  const patchText = extractPatchTextFromRawContent(rawContent);
  if (patchText === undefined) return [];
  return previewsFromPatchText(patchText);
}

function extractPatchTextFromRawContent(rawContent: string): string | undefined {
  if (!rawContent) return undefined;

  // Fast path — full JSON parses cleanly.
  try {
    const parsed: unknown = JSON.parse(rawContent);
    if (parsed && typeof parsed === "object") {
      return extractApplyPatchText(parsed as Record<string, unknown>);
    }
  } catch {
    // Fall through to the tolerant scanner.
  }

  return extractPatchTextFromPartialJson(rawContent);
}

function previewsFromPatchText(patchText: string): ApplyPatchPreview[] {
  const changes = parseApplyPatchChanges(patchText);
  const previews: ApplyPatchPreview[] = [];
  for (const change of changes) {
    const preview = previewFromChange(change);
    if (preview) previews.push(preview);
  }
  return previews;
}

function previewFromPatchText(patchText: string): ApplyPatchPreview | null {
  const changes = parseApplyPatchChanges(patchText);
  if (changes.length !== 1) return null;
  return previewFromChange(changes[0]);
}

/** Translate a single parsed `ApplyPatchChange` into the FE preview shape. */
function previewFromChange(change: ApplyPatchChange): ApplyPatchPreview | null {
  if (change.kind === "add") {
    const addedContent = change.addedLines.join("\n");
    return {
      filePath: change.moveTo ?? change.filePath,
      oldContent: "",
      newContent: addedContent || CREATED_FILE_PLACEHOLDER,
      emptyFileAction: addedContent ? undefined : "created",
    };
  }
  if (change.kind === "delete") {
    const removedContent = change.removedLines.join("\n");
    return {
      filePath: change.filePath,
      oldContent: removedContent || DELETED_FILE_PLACEHOLDER,
      emptyFileAction: removedContent ? undefined : "deleted",
      newContent: "",
    };
  }
  return {
    filePath: change.moveTo ?? change.filePath,
    oldContent: change.removedLines.join("\n"),
    newContent: change.addedLines.join("\n"),
  };
}

/**
 * Locate the `patch_text` (or `patchText`) string value inside a partial JSON
 * blob and decode JSON-string escapes up to the first unescaped closing quote
 * or end of input. Returns `undefined` when the key is absent.
 *
 * Only the common escapes (`\\`, `\"`, `\/`, `\n`, `\t`, `\r`, `\b`, `\f`,
 * `\uXXXX`) are decoded. A truncated `\uXXX` or trailing lone `\` at the end
 * of the buffer is dropped silently — the next streaming chunk will resupply
 * those bytes intact.
 */
function extractPatchTextFromPartialJson(raw: string): string | undefined {
  for (const key of PATCH_TEXT_KEYS) {
    const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(raw);
    if (match) return decodeJsonStringPrefix(raw, match.index + match[0].length);
  }
  return undefined;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
};

function decodeJsonStringPrefix(raw: string, start: number): string {
  // Scan in runs of plain characters and join once at the end. `result += ch`
  // per iteration is O(n²) for the multi-KB `patch_text` payloads we render
  // every streaming delta, so we slice runs and push into an array instead.
  const parts: string[] = [];
  let i = start;
  let runStart = start;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      parts.push(raw.slice(runStart, i));
      return parts.join("");
    }
    if (ch !== "\\") {
      i += 1;
      continue;
    }
    parts.push(raw.slice(runStart, i));
    // Truncated `\` or `\uXXX` at the buffer end is dropped silently — the
    // next streaming chunk will resupply the full escape intact.
    if (i + 1 >= raw.length) return parts.join("");
    const esc = raw[i + 1];
    if (esc === "u") {
      if (i + 6 > raw.length) return parts.join("");
      const hex = raw.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return parts.join("");
      parts.push(String.fromCharCode(parseInt(hex, 16)));
      i += 6;
    } else {
      const decoded = SIMPLE_ESCAPES[esc];
      if (decoded !== undefined) {
        parts.push(decoded);
      } else {
        // Unknown escape — keep the literal characters.
        parts.push(ch + esc);
      }
      i += 2;
    }
    runStart = i;
  }
  parts.push(raw.slice(runStart, i));
  return parts.join("");
}
