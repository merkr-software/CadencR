/**
 * Block mutation helpers — applying mutations to block arrays,
 * building message patches, and extracting todos.
 */

import type { AgentBlockData } from "@/components/AgentBlock";
import { isFileChangeTool } from "@/lib/tool-adapter";
import type { TodoItem } from "@/types/agent";
import type { BlockMutation, ParserSignals, StreamingState } from "./ws-message-processing";
import { parseTaskTodosFromBlocks, taskTodoMutationSeen } from "./ws-task-todos";
import { latestValidJsonSnapshot, mergeToolContent } from "./ws-tool-content";

export type ParsedTodo = TodoItem;
type InternalRootMutation =
  | BlockMutation
  | { action: "replace_parent"; block: AgentBlockData }
  | { action: "replace_block"; block: AgentBlockData };
type DuplicateChildAppendResult = { changed: boolean; parentToolUseId: string } | null;

/** Extract todos from the last TodoWrite block in a block list. */
export function parseTodosFromBlocks(blocks: AgentBlockData[]): ParsedTodo[] | undefined {
  const allBlocks = blocks.flatMap((b) => (b.childBlocks ? [b, ...b.childBlocks] : [b]));
  for (let i = allBlocks.length - 1; i >= 0; i--) {
    const b = allBlocks[i];
    if (b.type === "tool_call" && b.toolName === "TodoWrite") {
      const argsStr = b.toolArgs || b.content;
      if (!argsStr) return undefined;
      try {
        const parsed = JSON.parse(argsStr);
        if (Array.isArray(parsed?.todos)) {
          return parsed.todos.map((t: Record<string, unknown>) => ({
            content: String(t.content ?? ""),
            status: t.status as TodoItem["status"],
            activeForm: String(t.activeForm ?? ""),
          }));
        }
      } catch {
        /* Malformed JSON */
      }
      return undefined;
    }
    if (taskTodoMutationSeen(b)) return parseTaskTodosFromBlocks(blocks)?.todos;
  }
  return undefined;
}

export interface MessagePatch {
  blocks: AgentBlockData[];
  hasFileChanges?: boolean;
  todos?: ParsedTodo[];
  permissionMode?: "plan";
}

export function buildMessagePatch(
  newBlocks: AgentBlockData[],
  allMutations: BlockMutation[],
  signals: Pick<ParserSignals, "enterPlanModeRequested">,
): MessagePatch {
  const hasNewFileChange = allMutations.some(
    (m) =>
      m.action === "append" && m.block.type === "tool_call" && isFileChangeTool(m.block.toolName),
  );

  const mutatedIds = new Set(allMutations.map((m) => m.block.id));
  const todoBlock = findTodoBlock(newBlocks, mutatedIds, allMutations);

  const patch: MessagePatch = { blocks: newBlocks };
  if (hasNewFileChange) patch.hasFileChanges = true;
  if (todoBlock) {
    const todos = parseTodosFromBlocks([todoBlock]);
    if (todos) patch.todos = todos;
  }
  if (!todoBlock && hasTaskTodoMutation(newBlocks, mutatedIds, allMutations)) {
    const todos = parseTodosFromBlocks(newBlocks);
    if (todos) patch.todos = todos;
  }
  if (signals.enterPlanModeRequested) {
    patch.permissionMode = "plan";
  }
  return patch;
}

function findTodoBlock(
  newBlocks: AgentBlockData[],
  mutatedIds: Set<string>,
  allMutations: BlockMutation[],
): AgentBlockData | undefined {
  const top = newBlocks.find(
    (b) => b.type === "tool_call" && b.toolName === "TodoWrite" && mutatedIds.has(b.id),
  );
  if (top) return top;
  for (const b of newBlocks) {
    if (!b.childBlocks) continue;
    const child = b.childBlocks.find(
      (c) => c.type === "tool_call" && c.toolName === "TodoWrite" && mutatedIds.has(c.id),
    );
    if (child) return child;
  }
  return allMutations.find((m) => m.block.type === "tool_call" && m.block.toolName === "TodoWrite")
    ?.block;
}

function hasTaskTodoMutation(
  newBlocks: AgentBlockData[],
  mutatedIds: Set<string>,
  allMutations: BlockMutation[],
): boolean {
  if (allMutations.some((m) => taskTodoMutationSeen(m.block))) return true;
  return newBlocks.some((block) => blockOrChildTaskTodoMutated(block, mutatedIds));
}

function blockOrChildTaskTodoMutated(block: AgentBlockData, mutatedIds: Set<string>): boolean {
  if (mutatedIds.has(block.id) && taskTodoMutationSeen(block)) return true;
  return (
    block.childBlocks?.some((child) => blockOrChildTaskTodoMutated(child, mutatedIds)) ?? false
  );
}

export function applyMutations(
  prevBlocks: AgentBlockData[],
  allMutations: BlockMutation[],
  streamState: StreamingState,
): AgentBlockData[] {
  const dirtyParents = new Set<string>();
  const rootAppends: AgentBlockData[] = [];
  const rootUpdates: InternalRootMutation[] = [];

  for (const mut of allMutations) {
    if (mut.action === "append") {
      const existingRoot = rootBlockForId(streamState, mut.block.id);
      if (existingRoot) {
        const merged = mergeDuplicateAppend(existingRoot, mut.block);
        if (merged !== existingRoot) {
          rootUpdates.push({ action: "replace_block", block: merged });
        }
        continue;
      }
      const duplicateChild = replaceDuplicateChildAppend(streamState, mut.block);
      if (duplicateChild) {
        if (duplicateChild.changed) {
          dirtyParents.add(duplicateChild.parentToolUseId);
        }
        continue;
      }
      const parentId = mut.block.parentToolUseId;
      if (parentId) {
        const parentBlock = streamState.toolUseIdToBlock.get(parentId);
        if (parentBlock?.childBlocks) {
          parentBlock.childBlocks = [...parentBlock.childBlocks, mut.block];
          dirtyParents.add(parentId);
          recordDerivedBlock(streamState, mut.block);
          continue;
        }
      }
      rootAppends.push(mut.block);
      recordRootAppend(streamState, mut.block);
    } else {
      rootUpdates.push(mut);
    }
  }

  for (const parentToolUseId of dirtyParents) {
    const parentBlock = streamState.toolUseIdToBlock.get(parentToolUseId);
    if (parentBlock) {
      const newParent = { ...parentBlock };
      streamState.toolUseIdToBlock.set(parentToolUseId, newParent);
      rootUpdates.push({ action: "replace_parent", block: newParent });
    }
  }

  const result = [...prevBlocks, ...rootAppends];

  for (const mut of rootUpdates) {
    if (mut.action === "replace_parent" || mut.action === "replace_block") {
      const idx = rootResultIndexById(result, streamState, mut.block.id);
      if (idx !== -1) {
        result[idx] = mut.block;
        recordRootRefChange(streamState, mut.block.id, mut.block);
        recordDerivedBlock(streamState, mut.block);
      }
      continue;
    }
    const idx = rootResultIndexById(result, streamState, mut.block.id);
    if (idx !== -1) {
      const existing = { ...result[idx] };
      existing.content = mergeToolContent(existing, mut.block.content, mut.action);
      syncToolUseMap(streamState, existing);
      result[idx] = existing;
      recordRootRefChange(streamState, existing.id, existing);
    } else {
      applyChildUpdate(streamState, mut);
    }
  }

  return result;
}

function rootResultIndexById(
  blocks: AgentBlockData[],
  streamState: StreamingState,
  blockId: string,
): number {
  const indexed = streamState.rootBlockPosById.get(blockId);
  if (indexed !== undefined && blocks[indexed]?.id === blockId) {
    return indexed;
  }
  return blocks.findIndex((block) => block.id === blockId);
}

function rootBlockForId(streamState: StreamingState, blockId: string): AgentBlockData | undefined {
  const idx = streamState.rootBlockPosById.get(blockId);
  return idx === undefined ? undefined : streamState.rootBlocks[idx];
}

function replaceDuplicateChildAppend(
  streamState: StreamingState,
  incoming: AgentBlockData,
): DuplicateChildAppendResult {
  const parentToolUseId = incoming.parentToolUseId;
  if (!parentToolUseId) return null;
  const parentBlock = streamState.toolUseIdToBlock.get(parentToolUseId);
  if (!parentBlock?.childBlocks) return null;
  const childIdx = parentBlock.childBlocks.findIndex((block) => block.id === incoming.id);
  if (childIdx === -1) return null;
  const existingChild = parentBlock.childBlocks[childIdx];
  const merged = mergeDuplicateAppend(existingChild, incoming);
  if (merged === existingChild) {
    return { changed: false, parentToolUseId };
  }
  parentBlock.childBlocks = parentBlock.childBlocks.map((child, index) =>
    index === childIdx ? merged : child,
  );
  recordDerivedBlock(streamState, merged);
  return { changed: true, parentToolUseId };
}

function mergeDuplicateAppend(existing: AgentBlockData, incoming: AgentBlockData): AgentBlockData {
  const preferExistingContent = existing.content.length >= incoming.content.length;
  const incomingHasChildren = (incoming.childBlocks?.length ?? 0) > 0;
  if (preferExistingContent && !incomingHasChildren && !incoming.toolArgs) {
    return existing;
  }
  return {
    ...(preferExistingContent ? { ...incoming, ...existing } : { ...existing, ...incoming }),
    content: preferExistingContent ? existing.content : incoming.content,
    childBlocks: incomingHasChildren
      ? incoming.childBlocks
      : (existing.childBlocks ?? incoming.childBlocks),
    toolArgs: preferExistingContent
      ? (existing.toolArgs ?? incoming.toolArgs)
      : (incoming.toolArgs ?? existing.toolArgs),
  };
}

/**
 * Rebuild `streamState.rootBlocks`, `rootBlockPosById`, and `toolResultMap`
 * from a complete blocks array. Used when persisted state is loaded from the
 * DB so the incremental updates inside `applyMutations` start from a
 * consistent baseline.
 */
export function rebuildDerivedAgentStreamState(
  streamState: StreamingState,
  blocks: AgentBlockData[],
): void {
  streamState.rootBlocks = [];
  streamState.rootBlockPosById = new Map();
  streamState.toolResultMap = new Map();
  streamState.toolUseIdToBlock = new Map();
  for (const block of blocks) {
    if (!block.parentToolUseId) {
      streamState.rootBlockPosById.set(block.id, streamState.rootBlocks.length);
      streamState.rootBlocks.push(block);
    }
    recordDerivedBlock(streamState, block);
  }
}

function recordDerivedBlock(streamState: StreamingState, block: AgentBlockData): void {
  if (block.type === "tool_call" && block.toolUseId) {
    streamState.toolUseIdToBlock.set(block.toolUseId, block);
  }
  if (block.type === "tool_result" && block.toolUseId) {
    streamState.toolResultMap.set(block.toolUseId, block);
  }
  for (const child of block.childBlocks ?? []) {
    recordDerivedBlock(streamState, child);
  }
}

/**
 * Build a patch object that pairs a fresh `blocks` array with the derived
 * `rootBlocks` and `toolResultMap` so consumers don't have to remember to
 * recompute them at every blocks-mutation site outside the streaming path.
 *
 * Internally rebuilds the derived state on `streamState` (O(N)). Hot streaming
 * goes through `applyMutations`, which maintains the same fields in O(1) per
 * mutation; this helper is for the cold paths (persisted load, plan
 * approval, error blocks) where O(N) is fine because they are not per-chunk.
 */
export function blocksPatchWithDerived(
  streamState: StreamingState,
  blocks: AgentBlockData[],
): {
  blocks: AgentBlockData[];
  rootBlocks: AgentBlockData[];
  toolResultMap: Map<string, AgentBlockData>;
} {
  rebuildDerivedAgentStreamState(streamState, blocks);
  return {
    blocks,
    rootBlocks: streamState.rootBlocks.slice(),
    toolResultMap: new Map(streamState.toolResultMap),
  };
}

function recordRootAppend(streamState: StreamingState, block: AgentBlockData): void {
  streamState.rootBlockPosById.set(block.id, streamState.rootBlocks.length);
  streamState.rootBlocks.push(block);
  recordDerivedBlock(streamState, block);
}

function recordRootRefChange(
  streamState: StreamingState,
  blockId: string,
  newRef: AgentBlockData,
): void {
  const idx = streamState.rootBlockPosById.get(blockId);
  if (idx !== undefined) streamState.rootBlocks[idx] = newRef;
}

function applyChildUpdate(streamState: StreamingState, mut: BlockMutation): void {
  for (const parentBlock of streamState.toolUseIdToBlock.values()) {
    if (!parentBlock.childBlocks) continue;
    const childIdx = parentBlock.childBlocks.findIndex((b) => b.id === mut.block.id);
    if (childIdx === -1) continue;
    const child = { ...parentBlock.childBlocks[childIdx] };
    child.content = mergeToolContent(child, mut.block.content, mut.action);
    syncToolUseMap(streamState, child);
    parentBlock.childBlocks[childIdx] = child;
    break;
  }
}

function syncToolUseMap(streamState: StreamingState, block: AgentBlockData): void {
  if (block.type !== "tool_call") return;
  const latest = latestValidJsonSnapshot(block.content);
  if (!latest) return;
  block.toolArgs = latest;
  if (!block.toolUseId) return;
  const canonical = streamState.toolUseIdToBlock.get(block.toolUseId);
  if (canonical && canonical !== block) {
    canonical.toolArgs = block.toolArgs;
    canonical.content = block.content;
  }
}
