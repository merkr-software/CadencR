import type { SessionPrompt } from "@/api/generated";
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import { parseUserMessageContent } from "@/types/agent-types";

/**
 * Workspace setting key for the agent-tab message navigator (the rail of
 * user-message ticks along the stream's right edge). Stored as "true" /
 * "false"; unset (null) resolves to enabled.
 */
export const AGENT_MESSAGE_NAVIGATOR_SETTING_KEY = "agent_message_navigator_enabled";

/** Parse the persisted navigator setting. Defaults to on. */
export function parseAgentMessageNavigator(value: string | null | undefined): boolean {
  return value !== "false";
}

/** One user prompt the navigator can jump to. */
export interface UserMessageMark {
  /** Stable React key: the DB id once persisted, else the live block id. */
  key: string;
  messageDbId?: number;
  /** Transcript block rendering this prompt, or null while it isn't loaded. */
  blockId: string | null;
  /**
   * Index into the Virtuoso `data` (the display-item list), or null while the
   * prompt sits in history that hasn't been paged in yet.
   */
  rowIndex: number | null;
  /** Prompt text, whitespace-collapsed for the preview. */
  text: string;
  createdAt?: string;
  imageCount: number;
  attachmentCount: number;
}

/** Only what the user typed: messages other sessions or the system wrote are left out. */
function isOwnPrompt(block: AgentBlockData): boolean {
  if (block.type !== "user_message" || block.parentToolUseId) return false;
  const kind = block.origin?.originKind;
  return kind !== "session_generated" && kind !== "system_generated";
}

interface PromptSummary {
  text: string;
  imageCount: number;
  attachmentCount: number;
}

/**
 * Parsed prompt per block object. Blocks are immutable, so a streaming chunk
 * (which rebuilds the item list) re-uses every prompt's parse instead of
 * re-running `JSON.parse` over structured prompts on each chunk.
 */
const summaryCache = new WeakMap<AgentBlockData, PromptSummary>();

function summarize(block: AgentBlockData): PromptSummary {
  const cached = summaryCache.get(block);
  if (cached) return cached;
  const parsed = parseUserMessageContent(block.content);
  const summary = {
    text: parsed.text.replace(/\s+/g, " ").trim(),
    imageCount: parsed.images.length,
    attachmentCount: parsed.attachments.length,
  };
  summaryCache.set(block, summary);
  return summary;
}

function loadedMark(block: AgentBlockData, rowIndex: number): UserMessageMark {
  const summary = summarize(block);
  return {
    key: block.messageDbId === undefined ? block.id : `db:${block.messageDbId}`,
    messageDbId: block.messageDbId,
    blockId: block.id,
    rowIndex,
    createdAt: block.createdAt,
    ...summary,
  };
}

/** The user's prompts among the rows currently paged in, in stream order. */
export function collectLoadedMarks(items: readonly DisplayItem[]): UserMessageMark[] {
  const marks: UserMessageMark[] = [];
  for (let rowIndex = 0; rowIndex < items.length; rowIndex += 1) {
    const item = items[rowIndex];
    if (item.kind === "block" && isOwnPrompt(item.block)) {
      marks.push(loadedMark(item.block, rowIndex));
    }
  }
  return marks;
}

/**
 * The full prompt list: every prompt the server knows about (so the rail
 * doesn't grow as history pages in), placed on its row when loaded, followed
 * by loaded prompts the server list doesn't have yet — a prompt still in
 * flight, or one sent after the list was fetched. Without a server list the
 * loaded prompts are all we can show.
 */
export function mergeMarks(
  prompts: readonly SessionPrompt[] | undefined,
  loaded: readonly UserMessageMark[],
): UserMessageMark[] {
  if (!prompts) return [...loaded];
  const loadedById = new Map<number, UserMessageMark>();
  for (const mark of loaded) {
    if (mark.messageDbId !== undefined) loadedById.set(mark.messageDbId, mark);
  }
  const marks: UserMessageMark[] = prompts.map((prompt) => {
    const loadedPrompt = loadedById.get(prompt.id);
    return {
      key: `db:${prompt.id}`,
      messageDbId: prompt.id,
      blockId: loadedPrompt?.blockId ?? null,
      rowIndex: loadedPrompt?.rowIndex ?? null,
      text: prompt.preview,
      createdAt: prompt.created_at ?? undefined,
      imageCount: prompt.image_count,
      attachmentCount: prompt.attachment_count,
    };
  });
  const listed = new Set(prompts.map((prompt) => prompt.id));
  for (const mark of loaded) {
    if (mark.messageDbId === undefined || !listed.has(mark.messageDbId)) marks.push(mark);
  }
  return marks;
}

/**
 * Whether the server list has drifted from the transcript: a persisted prompt
 * it doesn't list (sent after the fetch), or a listed prompt newer than the
 * newest loaded one (removed by a rewind — the newest history is always
 * loaded). Returns a signature of the drift so a refetch is tried once per
 * distinct drift, or null when the list is current.
 */
export function promptListDrift(
  prompts: readonly SessionPrompt[] | undefined,
  loaded: readonly UserMessageMark[],
): string | null {
  if (!prompts) return null;
  const listed = new Set(prompts.map((prompt) => prompt.id));
  const loadedIds = loaded.flatMap((mark) =>
    mark.messageDbId === undefined ? [] : [mark.messageDbId],
  );
  const unlisted = loadedIds.filter((id) => !listed.has(id));
  const newestLoaded = loadedIds.length > 0 ? Math.max(...loadedIds) : null;
  const stale =
    newestLoaded === null ? [] : prompts.filter((p) => p.id > newestLoaded).map((p) => p.id);
  if (unlisted.length === 0 && stale.length === 0) return null;
  return `${unlisted.join(",")}|${stale.join(",")}`;
}

function sameMark(a: UserMessageMark, b: UserMessageMark): boolean {
  return (
    a.key === b.key &&
    a.blockId === b.blockId &&
    a.rowIndex === b.rowIndex &&
    a.text === b.text &&
    a.createdAt === b.createdAt &&
    a.imageCount === b.imageCount &&
    a.attachmentCount === b.attachmentCount
  );
}

/**
 * Returns `previous` when `next` describes the same marks, so the rail keeps a
 * stable array identity across streaming chunks that never touch a prompt.
 */
export function reuseMarksIfEqual(
  previous: UserMessageMark[],
  next: UserMessageMark[],
): UserMessageMark[] {
  if (previous.length !== next.length) return next;
  for (let i = 0; i < next.length; i += 1) {
    if (!sameMark(previous[i], next[i])) return next;
  }
  return previous;
}

/**
 * Where each prompt sits along the loaded rows. A loaded prompt sits on its
 * row; an unloaded one just after the loaded row preceding it — before the
 * whole window when it is older history, or in the gap after the session's
 * first prompt, which the server ships ahead of the window as an anchor.
 */
function markPositions(marks: readonly UserMessageMark[]): number[] {
  let previousRow = -1;
  return marks.map((mark) => {
    if (mark.rowIndex === null) return previousRow + 0.5;
    previousRow = mark.rowIndex;
    return mark.rowIndex;
  });
}

/** Index of the prompt whose turn contains `row`, or -1. */
export function markIndexAtRow(marks: readonly UserMessageMark[], row: number): number {
  const positions = markPositions(marks);
  let found = -1;
  for (let i = 0; i < positions.length && positions[i] <= row; i += 1) found = i;
  return found;
}

/**
 * Index of the closest prompt before (`-1`) or after (`1`) `row`, or -1 —
 * unloaded prompts included, so the keyboard can walk into unloaded history.
 */
export function adjacentMarkIndex(
  marks: readonly UserMessageMark[],
  row: number,
  direction: -1 | 1,
): number {
  const positions = markPositions(marks);
  if (direction === 1) return positions.findIndex((position) => position > row);
  return positions.findLastIndex((position) => position < row);
}

/** Maps a 0–1 position along the rail to the tick drawn there. */
export function markIndexAtFraction(fraction: number, count: number): number {
  if (count <= 0) return -1;
  const clamped = Math.min(Math.max(fraction, 0), 0.999_999);
  return Math.floor(clamped * count);
}
