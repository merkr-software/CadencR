/**
 * Block-merge helpers for `useFeatureAgentState`. Extracted to keep the hook
 * file under the 400-line project cap (`.claude/rules/file-size.md`). No
 * runtime behavior change — these are the same pure functions previously
 * defined inline in `useFeatureAgentState.ts`.
 */

import type { AgentBlock } from "../api/generated";
import type { AgentBlockData } from "@/components/AgentBlock";

function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

export function serverBlocksToAgentBlocks(serverBlocks: AgentBlock[]): AgentBlockData[] {
  return serverBlocks.map((sb) => {
    const isSubagent =
      sb.type === "tool_call" && (sb.toolName === "Task" || sb.toolName === "Agent");
    const childBlocks = sb.childBlocks
      ? serverBlocksToAgentBlocks(sb.childBlocks as unknown as AgentBlock[])
      : undefined;
    return {
      id: sb.id,
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
      // DB-loaded sub-agents are always complete (streaming state handles the active one)
      ...(isSubagent ? { taskComplete: true } : {}),
    };
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
      last.content += block.content;
    } else {
      targetList.push(block);
    }
  }
}

/**
 * Apply in-place updates to tool_call blocks whose content was updated
 * via input_json_delta after the initial insert (invisible to incremental fetch).
 * Returns true if any block was updated.
 */
export function applyToolCallUpdates(
  blocks: AgentBlockData[],
  updates: Record<string, string>,
): boolean {
  let changed = false;
  function walk(list: AgentBlockData[]) {
    for (const b of list) {
      if (b.id in updates) {
        const newContent = updates[b.id];
        if (b.content !== newContent) {
          b.content = newContent;
          b.toolArgs = newContent;
          changed = true;
        }
      }
      if (b.childBlocks) walk(b.childBlocks);
    }
  }
  walk(blocks);
  return changed;
}
