/**
 * Per-block content budget for the agent stream.
 *
 * Production conversations contain single messages far larger than anything a
 * renderer can absorb: an 18.5 MB `Bash` tool_call, a 14 MB user_message, and
 * several 9 MB tool_results. The backend only tail-truncates Bash *tool_results*
 * (200 lines / 8 KB — see `repository/truncation.rs`), so every other shape
 * reaches the client whole.
 *
 * This module clamps block content at the store boundary. It does not avoid the
 * initial parse — axios has already materialized the response by then — but it
 * is what stops the value from being *retained* in the Zustand store for the
 * session and re-handed to the markdown parser on every mount.
 *
 * Clamped blocks set `truncatedContent`. Note that only Bash tool_results
 * currently render the "load full output" affordance
 * (`GET /api/sessions/messages/{id}/full`); for every other shape the inline
 * `TRUNCATION_NOTICE` is the user-visible signal.
 */

import type { AgentBlockData } from "@/types/agent-block";
import { extractPromptBlobs } from "@/lib/prompt-image-cache";

/**
 * Maximum characters retained for a single block's `content` or `toolArgs`.
 *
 * 128 K UTF-16 code units is roughly 20k words — beyond any prose an agent
 * produces and beyond any diff a human reads in one block, while still being
 * 145× smaller than the largest message in production.
 */
export const BLOCK_CONTENT_MAX_CHARS = 128 * 1024;

/**
 * Share of the budget spent on the head of the value. Outputs put errors at the
 * end and prose puts the point at the start, so keep both ends and drop the
 * middle.
 */
const HEAD_SHARE = 2 / 3;

/** Minimum budget for a JSON string leaf before we give up and clamp raw. */
const MIN_LEAF_BUDGET = 1024;

export interface ClampedText {
  text: string;
  truncated: boolean;
}

/** Sentinel shown in place of the dropped content. Also marks a re-clamp. */
export const TRUNCATION_NOTICE = "… content truncated …";

/**
 * Re-clamping an already-clamped value (the streaming append path) can only
 * measure the clamped length, so the character count would understate what was
 * really dropped. Detect the sentinel and omit the number rather than print a
 * wrong one.
 */
function marker(hiddenChars: number, alreadyTruncated: boolean): string {
  if (alreadyTruncated) return `${TRUNCATION_NOTICE}\n\n`;
  return `${TRUNCATION_NOTICE} (${hiddenChars.toLocaleString()} characters hidden)\n\n`;
}

/**
 * Slice without splitting a surrogate pair. `String.prototype.slice` operates on
 * UTF-16 code units, so cutting between a high and low surrogate yields a lone
 * surrogate that breaks JSON round-trips and renders as a replacement char.
 */
function sliceHead(text: string, end: number): string {
  if (end <= 0) return "";
  if (end >= text.length) return text;
  const code = text.charCodeAt(end - 1);
  // High surrogate at the cut point — drop it, its pair is on the other side.
  const safeEnd = code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
  return text.slice(0, safeEnd);
}

function sliceTail(text: string, start: number): string {
  if (start <= 0) return text;
  if (start >= text.length) return "";
  const code = text.charCodeAt(start);
  // Low surrogate at the cut point — start one later so we don't orphan it.
  const safeStart = code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
  return text.slice(safeStart);
}

/** Clamp a plain string to `max` characters, keeping the head and the tail. */
export function clampText(text: string, max: number = BLOCK_CONTENT_MAX_CHARS): ClampedText {
  if (text.length <= max) return { text, truncated: false };
  const headBudget = Math.floor(max * HEAD_SHARE);
  const tailBudget = max - headBudget;
  const head = sliceHead(text, headBudget);
  const tail = sliceTail(text, text.length - tailBudget);
  const hidden = text.length - head.length - tail.length;
  const notice = marker(hidden, text.includes(TRUNCATION_NOTICE));
  return { text: `${head}\n\n${notice}${tail}`, truncated: true };
}

/**
 * Clamp to the *last* `max` characters. Streamed command output is watched at
 * its tail, and the server tail-truncates the same field when it persists it
 * (`truncate_bash_output`), so keeping the head here would leave the live view
 * and the reloaded view showing different halves of one output.
 */
export function clampTailText(text: string, max: number): ClampedText {
  if (text.length <= max) return { text, truncated: false };
  const tail = sliceTail(text, text.length - max);
  const notice = marker(text.length - tail.length, text.includes(TRUNCATION_NOTICE));
  return { text: `${notice}${tail}`, truncated: true };
}

/**
 * Clamp the string leaves of a JSON value, returning whether anything was cut.
 * Structure is preserved so `parseToolArgsObject` and the file-change renderers
 * keep working on a clamped `toolArgs`.
 */
function clampJsonLeaves(value: unknown, leafBudget: number): { value: unknown; cut: boolean } {
  if (typeof value === "string") {
    const clamped = clampText(value, leafBudget);
    return { value: clamped.text, cut: clamped.truncated };
  }
  if (Array.isArray(value)) {
    let cut = false;
    const next = value.map((entry) => {
      const result = clampJsonLeaves(entry, leafBudget);
      if (result.cut) cut = true;
      return result.value;
    });
    return { value: cut ? next : value, cut };
  }
  if (value && typeof value === "object") {
    let cut = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const result = clampJsonLeaves(entry, leafBudget);
      if (result.cut) cut = true;
      next[key] = result.value;
    }
    return { value: cut ? next : value, cut };
  }
  return { value, cut: false };
}

type JsonClamp =
  | { status: "clamped"; result: ClampedText }
  /** Did not parse — a fragment of an envelope still being streamed. */
  | { status: "incomplete" }
  /** Parsed, but shrinking its leaves can't get it under budget. */
  | { status: "unshrinkable" };

/**
 * Clamp by shrinking the JSON's string leaves, keeping the value parseable.
 *
 * The leaf budget shrinks until the whole thing fits, because one budget per
 * leaf overflows as soon as an envelope carries more than one big string — and
 * they do: a Codex Bash envelope repeats its entire output under both
 * `aggregatedOutput` and `output`, so two half-budget leaves alone exceed the
 * cap. Giving up there is not a neutral outcome; the caller's fallback is a raw
 * clamp, which destroys the JSON.
 */
function clampJsonStructurally(text: string, max: number): JsonClamp {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "incomplete" };
  }
  return clampParsedJsonStructurally(parsed, max);
}

function clampParsedJsonStructurally(parsed: unknown, max: number): JsonClamp {
  if (!parsed || typeof parsed !== "object") return { status: "unshrinkable" };

  let leafBudget = Math.max(MIN_LEAF_BUDGET, Math.floor(max / 2));
  for (;;) {
    const { value, cut } = clampJsonLeaves(parsed, leafBudget);
    // Nothing left to shrink: the structure itself is what exceeds the budget
    // (thousands of tiny fields). Nothing this function can do.
    if (!cut) return { status: "unshrinkable" };
    const serialized = JSON.stringify(value);
    if (serialized.length <= max) {
      return { status: "clamped", result: { text: serialized, truncated: true } };
    }
    if (leafBudget <= MIN_LEAF_BUDGET) return { status: "unshrinkable" };
    leafBudget = Math.max(MIN_LEAF_BUDGET, Math.floor(leafBudget / 4));
  }
}

/** Cheap test for "this is JSON, or the beginning of some". */
function looksLikeJson(text: string): boolean {
  const first = text.trimStart()[0];
  return first === "{" || first === "[";
}

/**
 * Clamp a value that may be a JSON envelope (`toolArgs`, Bash result payloads).
 *
 * Tool content streams in as partial JSON fragments and only completes at the
 * end of the turn, so an *unfinished* envelope is left alone. Raw-clamping one
 * would drop the notice — raw newlines and all — inside a string literal, and it
 * would never parse again: `latestValidJsonSnapshot` would stop resolving
 * `toolArgs` and the tool renderers would dump raw JSON at the user for the rest
 * of the turn. That costs memory until the envelope completes and can be clamped
 * structurally, which is the right trade against corrupting what the user sees.
 *
 * A value that *has* completed is final, so if its leaves can't be shrunk under
 * budget it is raw-clamped: bounded memory beats fidelity on a value nothing
 * else will fix.
 */
export function clampJsonText(text: string, max: number = BLOCK_CONTENT_MAX_CHARS): ClampedText {
  if (text.length <= max) return { text, truncated: false };
  const attempt = clampJsonStructurally(text, max);
  if (attempt.status === "clamped") return attempt.result;
  if (attempt.status === "incomplete" && looksLikeJson(text)) return { text, truncated: false };
  return clampText(text, max);
}

/** Clamp JSON that the caller has already parsed without parsing the large value again. */
export function clampParsedJsonText(
  text: string,
  parsed: unknown,
  max: number = BLOCK_CONTENT_MAX_CHARS,
): ClampedText {
  if (text.length <= max) return { text, truncated: false };
  const attempt = clampParsedJsonStructurally(parsed, max);
  return attempt.status === "clamped" ? attempt.result : clampText(text, max);
}

/** Move attachment payloads to the blob cache, keeping the block reference when there are none. */
function withExtractedPromptBlobs(block: AgentBlockData): AgentBlockData {
  const content = extractPromptBlobs(block.content);
  return content === block.content ? block : { ...block, content };
}

/**
 * Clamp a completed `user_message` envelope, keeping it parseable.
 *
 * Unlike tool content, a user message is never a half-streamed fragment, so an
 * envelope that fails to parse here is genuinely prose that happens to start
 * with `[` — raw-clamping that is correct, where doing the same to real JSON
 * would leave `parseUserMessageContent` dumping the envelope at the user as
 * text.
 */
function clampUserMessageText(text: string, max: number): ClampedText {
  const attempt = clampJsonStructurally(text, max);
  if (attempt.status === "clamped") return attempt.result;
  return clampText(text, max);
}

/**
 * Apply the budget to one block. Returns the *same reference* when nothing had
 * to be cut so `React.memo` and the store's in-place merge paths are unaffected
 * for the overwhelming majority of blocks.
 */
export function applyBlockContentBudget(
  block: AgentBlockData,
  max: number = BLOCK_CONTENT_MAX_CHARS,
): AgentBlockData {
  // Attachment payloads are lifted out before anything is measured: they are
  // the only reason a user message is ever over budget, and clamping one would
  // corrupt the envelope that carries it. This is not truncation — the payload
  // is preserved, just not in the block. See `prompt-image-cache`.
  const subject = block.type === "user_message" ? withExtractedPromptBlobs(block) : block;
  const overContent = subject.content.length > max;
  const overArgs = (subject.toolArgs?.length ?? 0) > max;
  if (!overContent && !overArgs) return subject;

  const next = { ...subject };
  if (overContent) {
    // `tool_call` content and `toolArgs` are both JSON envelopes on every
    // provider; text/thinking are prose, and a user message is either.
    const clamped =
      subject.type === "tool_call" || subject.type === "tool_result"
        ? clampJsonText(subject.content, max)
        : subject.type === "user_message"
          ? clampUserMessageText(subject.content, max)
          : clampText(subject.content, max);
    next.content = clamped.text;
  }
  if (overArgs && subject.toolArgs) {
    next.toolArgs = clampJsonText(subject.toolArgs, max).text;
  }
  next.truncatedContent = true;
  return next;
}
