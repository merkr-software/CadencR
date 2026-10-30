/**
 * Block-merge helpers for `useFeatureAgentState`. Extracted to keep the hook
 * file under the 400-line project cap (`.claude/rules/file-size.md`). No
 * runtime behavior change — these are the same pure functions previously
 * defined inline in `useFeatureAgentState.ts`.
 */

import type { AgentBlock } from "../api/generated";
import type { AgentBlockData } from "@/components/AgentBlock";
import { applyBlockContentBudget, clampJsonText, clampText } from "@/lib/block-content-budget";
import { isSubagentToolName } from "@/lib/tool-display-policy";
import {
  mergeCanonicalUserBlock,
  messageDbIdFromBlockId,
  sameMessageIdentity,
} from "@/stores/ws-user-message-reconciliation";

function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

export function serverBlocksToAgentBlocks(serverBlocks: AgentBlock[]): AgentBlockData[] {
  return serverBlocks.map((sb) => {
    const isSubagent = sb.type === "tool_call" && isSubagentToolName(sb.toolName ?? undefined);
    const childBlocks = sb.childBlocks
      ? serverBlocksToAgentBlocks(sb.childBlocks as unknown as AgentBlock[])
      : undefined;
    // Clamp before the block is retained: this is the only choke point every
    // hydrated and paginated block passes through. See `block-content-budget`.
    return applyBlockContentBudget({
      id: sb.id,
      messageUuid: nullToUndefined(sb.messageUuid),
      promptDeliveryState: nullToUndefined(sb.promptDeliveryState),
      messageDbId: messageDbIdFromBlockId(sb.id) ?? undefined,
      type: sb.type as AgentBlockData["type"],
      content: sb.content,
      toolName: nullToUndefined(sb.toolName),
      toolArgs: nullToUndefined(sb.toolArgs),
      isError: nullToUndefined(sb.isError),
      toolUseId: nullToUndefined(sb.toolUseId),
      parentToolUseId: sb.parentToolUseId ?? null,
      childBlocks,
      sourceToolName: nullToUndefined(sb.sourceToolName),
      createdAt: nullToUndefined(sb.createdAt),
      model: nullToUndefined(sb.model),
      origin: sb.origin ?? null,
      truncatedContent: sb.truncatedContent === true,
      fullContentBytes: nullToUndefined(sb.fullContentBytes),
      // DB-loaded sub-agents are always complete (streaming state handles the active one)
      ...(isSubagent ? { taskComplete: true } : {}),
    });
  });
}

/** Per-session accumulator shape consumed by the merge helpers below. */
export interface AccumulatedSession {
  blocks: AgentBlockData[];
  maxMessageId: number;
  /** toolUseId → { toolName, block ref (for nesting child blocks) } */
  toolUseIdMap: Map<string, { toolName: string; block: AgentBlockData }>;
  /** Cached todos — preserved across incremental updates when server returns null */
  todos: import("@/types/agent").TodoItem[] | null;
  /** Whether older messages exist beyond the current window */
  hasMore: boolean;
  /** Lowest message ID in the current window (cursor for loading older) */
  oldestMessageId: number | null;
}

/** Build the toolUseIdMap from a complete block tree (used on full fetch). */
export function buildToolUseIdMap(
  blocks: AgentBlockData[],
): Map<string, { toolName: string; block: AgentBlockData }> {
  const map = new Map<string, { toolName: string; block: AgentBlockData }>();
  function walk(list: AgentBlockData[]) {
    for (const b of list) {
      if (b.type === "tool_call" && b.toolUseId) {
        map.set(b.toolUseId, { toolName: b.toolName ?? "tool", block: b });
      }
      if (b.childBlocks) walk(b.childBlocks);
    }
  }
  walk(blocks);
  return map;
}

/**
 * Merge incremental blocks into the accumulated block tree.
 *
 * Handles:
 * - Text/thinking boundary merging (consecutive blocks of same type are concatenated)
 * - Re-nesting: blocks with parentToolUseId are placed into the parent's childBlocks
 * - sourceToolName resolution for tool_result blocks via toolUseIdMap
 * - Registering new tool_call blocks in toolUseIdMap
 */
export function mergeIncrementalBlocks(acc: AccumulatedSession, newBlocks: AgentBlockData[]): void {
  for (const block of newBlocks) {
    if (block.type === "tool_call" && block.toolUseId) {
      const existing = acc.toolUseIdMap.get(block.toolUseId)?.block;
      if (existing) {
        existing.content = block.content;
        existing.toolArgs = block.toolArgs;
        existing.toolName = block.toolName;
        existing.parentToolUseId = block.parentToolUseId;
        existing.createdAt = block.createdAt;
        existing.model = block.model;
        acc.toolUseIdMap.set(block.toolUseId, {
          toolName: block.toolName ?? existing.toolName ?? "tool",
          block: existing,
        });
        continue;
      }
    }

    // Determine the target list (root or nested under a parent tool_call)
    let targetList: AgentBlockData[];
    if (block.parentToolUseId) {
      const parent = acc.toolUseIdMap.get(block.parentToolUseId);
      if (parent?.block.childBlocks) {
        targetList = parent.block.childBlocks;
      } else {
        targetList = acc.blocks;
      }
    } else {
      targetList = acc.blocks;
    }

    if (block.type === "user_message") {
      const existingIndex = targetList.findIndex((held) => sameMessageIdentity(held, block));
      if (existingIndex !== -1) {
        targetList[existingIndex] = mergeCanonicalUserBlock(targetList[existingIndex], block);
        continue;
      }
    }

    // Resolve sourceToolName for tool_result blocks that couldn't find their
    // parent tool_call in the partial buildBlocks pass
    if (block.type === "tool_result" && !block.sourceToolName && block.toolUseId) {
      const entry = acc.toolUseIdMap.get(block.toolUseId);
      if (entry) block.sourceToolName = entry.toolName;
    }

    // Register tool_call blocks so future incremental batches can nest into them
    if (block.type === "tool_call" && block.toolUseId) {
      acc.toolUseIdMap.set(block.toolUseId, { toolName: block.toolName ?? "tool", block });
    }

    // Merge text/thinking at boundary
    const last = targetList.length > 0 ? targetList[targetList.length - 1] : null;
    if (
      last &&
      block.type === last.type &&
      (block.type === "text" || block.type === "thinking") &&
      Boolean(last.parentToolUseId) === Boolean(block.parentToolUseId)
    ) {
      // Boundary-merged text accumulates across every incremental fetch, so the
      // budget has to be enforced on the concatenation, not just per block.
      const merged = clampText(last.content + block.content);
      last.content = merged.text;
      if (merged.truncated) last.truncatedContent = true;
    } else {
      targetList.push(block);
    }
  }
}

const NO_TRUNCATED_TOOL_UPDATES: ReadonlySet<string> = new Set();

/** Apply persisted in-place tool-call revisions without mutating held state. */
export function applyToolCallUpdates(
  blocks: AgentBlockData[],
  updates: Record<string, string | null> | null | undefined,
  truncatedIds: ReadonlySet<string> = NO_TRUNCATED_TOOL_UPDATES,
): AgentBlockData[] {
  if (!updates || Object.keys(updates).length === 0) return blocks;
  let changed = false;
  const mapped = blocks.map((block) => {
    const children = block.childBlocks
      ? applyToolCallUpdates(block.childBlocks, updates, truncatedIds)
      : block.childBlocks;
    const persistedId = block.messageDbId == null ? undefined : `msg-${block.messageDbId}`;
    const updateId = block.id in updates ? block.id : persistedId;
    const candidate = block.type === "tool_call" && updateId ? updates[updateId] : undefined;
    const clamped = typeof candidate === "string" ? clampJsonText(candidate) : undefined;
    const truncated = clamped?.truncated || truncatedIds.has(updateId ?? "") ? true : undefined;
    const contentChanged =
      clamped != null &&
      (block.content !== clamped.text ||
        block.toolArgs !== clamped.text ||
        block.truncatedContent !== truncated);
    if (!contentChanged && children === block.childBlocks) return block;
    changed = true;
    return {
      ...block,
      ...(contentChanged
        ? // The revision's own size is unknown; a stale one would mislabel it.
          {
            content: clamped.text,
            toolArgs: clamped.text,
            truncatedContent: truncated,
            fullContentBytes: undefined,
          }
        : {}),
      ...(children === block.childBlocks ? {} : { childBlocks: children }),
    };
  });
  return changed ? mapped : blocks;
}
