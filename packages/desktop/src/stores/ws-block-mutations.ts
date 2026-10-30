import type { AgentBlockData } from "@/components/AgentBlock";
import { isFileChangeTool } from "@/lib/tool-adapter";
import type { TodoItem } from "@/types/agent";
import type { BlockMutation, ParserSignals, StreamingState } from "./ws-message-processing";
import { parseTaskTodosFromBlocks, taskTodoMutationSeen } from "./ws-task-todos";
import { applyBlockContentMutation } from "./ws-tool-content-mutations";
import {
  buildDatabaseIdentityOwners,
  mergeDuplicateAppend,
  type DatabaseIdentityOwners,
} from "./ws-block-reconciliation";
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
  rootAppendIndex = prevBlocks.length,
): AgentBlockData[] {
  const dirtyParents = new Set<string>();
  const rootAppends: AgentBlockData[] = [];
  const rootUpdates: InternalRootMutation[] = [];
  const boundedRootAppendIndex = Math.max(0, Math.min(rootAppendIndex, prevBlocks.length));

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
      recordRootAppend(streamState, mut.block, boundedRootAppendIndex + rootAppends.length - 1);
    } else {
      pushCoalescedUpdate(rootUpdates, mut);
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

  const result = [
    ...prevBlocks.slice(0, boundedRootAppendIndex),
    ...rootAppends,
    ...prevBlocks.slice(boundedRootAppendIndex),
  ];
  let changed = rootAppends.length > 0;
  let databaseOwners: DatabaseIdentityOwners | undefined;

  for (const mut of rootUpdates) {
    if (mut.action === "identify")
      databaseOwners ??= buildDatabaseIdentityOwners(result, rootUpdates);
    if (mut.action === "replace_parent" || mut.action === "replace_block") {
      const idx = rootResultIndexById(result, streamState, mut.block.id);
      if (idx !== -1) {
        result[idx] = mut.block;
        recordRootRefChange(streamState, mut.block.id, mut.block);
        recordDerivedBlock(streamState, mut.block);
        changed = true;
      }
      continue;
    }
    const idx = rootResultIndexById(result, streamState, mut.block.id);
    if (idx !== -1) {
      const previous = result[idx];
      const existing = { ...previous };
      if (!applyBlockContentMutation(streamState, existing, mut, databaseOwners)) {
        const stream = streamState.structuredToolStreams.get(existing.id);
        if (stream) stream.owner = previous;
        continue;
      }
      result[idx] = existing;
      recordRootRefChange(streamState, existing.id, existing);
      changed = true;
    } else if (applyChildUpdate(streamState, mut, databaseOwners)) {
      changed = true;
    }
  }

  return changed ? result : prevBlocks;
}

function pushCoalescedUpdate(updates: InternalRootMutation[], mutation: BlockMutation): void {
  const previous = updates.at(-1);
  if (
    mutation.action === "update" &&
    previous?.action === "update" &&
    previous.block.id === mutation.block.id &&
    previous.block.type === mutation.block.type
  ) {
    previous.block = {
      ...previous.block,
      content: previous.block.content + mutation.block.content,
    };
    return;
  }
  updates.push(mutation);
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
  const staleStreams = new Set(streamState.structuredToolStreams.keys());
  // Full rebuild replaces both derived structures; bump so any pending
  // before/after version comparison on the hot path sees the change.
  streamState.rootBlocksVersion += 1;
  streamState.toolResultMapVersion += 1;
  for (const block of blocks) {
    if (!block.parentToolUseId) {
      streamState.rootBlockPosById.set(block.id, streamState.rootBlocks.length);
      streamState.rootBlocks.push(block);
    }
    recordDerivedBlock(streamState, block, staleStreams);
  }
  for (const blockId of staleStreams) streamState.structuredToolStreams.delete(blockId);
}

function recordDerivedBlock(
  streamState: StreamingState,
  block: AgentBlockData,
  staleStreams?: Set<string>,
): void {
  const structuredStream = streamState.structuredToolStreams.get(block.id);
  if (block.type === "tool_call" && structuredStream?.owner === block)
    staleStreams?.delete(block.id);
  if (block.type === "tool_call" && block.toolUseId) {
    streamState.toolUseIdToBlock.set(block.toolUseId, block);
  }
  if (block.type === "tool_result" && block.toolUseId) {
    streamState.toolResultMap.set(block.toolUseId, block);
    // Only write site for `toolResultMap`; bump so the caller knows to re-snapshot.
    streamState.toolResultMapVersion += 1;
  }
  for (const child of block.childBlocks ?? []) {
    recordDerivedBlock(streamState, child, staleStreams);
  }
}

/**
 * Build a patch object that pairs a fresh `blocks` array with the derived
 * `rootBlocks` and `toolResultMap` so consumers don't have to remember to
 * recompute them at every blocks-mutation site outside the streaming path.
 *
 * Internally rebuilds the derived state on `streamState` (O(N)). Hot streaming
 * goes through `applyMutations`, which updates only affected blocks (and, for
 * an inserted root, the shifted suffix); this helper is for cold paths where
 * O(N) is fine because they are not per-chunk.
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

function recordRootAppend(
  streamState: StreamingState,
  block: AgentBlockData,
  requestedIndex: number,
): void {
  const insertionIndex = Math.min(requestedIndex, streamState.rootBlocks.length);
  streamState.rootBlocks.splice(insertionIndex, 0, block);
  for (let index = insertionIndex; index < streamState.rootBlocks.length; index += 1) {
    streamState.rootBlockPosById.set(streamState.rootBlocks[index].id, index);
  }
  streamState.rootBlocksVersion += 1;
  recordDerivedBlock(streamState, block);
}

function recordRootRefChange(
  streamState: StreamingState,
  blockId: string,
  newRef: AgentBlockData,
): void {
  const idx = streamState.rootBlockPosById.get(blockId);
  if (idx !== undefined) {
    streamState.rootBlocks[idx] = newRef;
    streamState.rootBlocksVersion += 1;
  }
}

function applyChildUpdate(
  streamState: StreamingState,
  mut: BlockMutation,
  databaseOwners?: DatabaseIdentityOwners,
): boolean {
  for (const parentBlock of streamState.toolUseIdToBlock.values()) {
    if (!parentBlock.childBlocks) continue;
    const childIdx = parentBlock.childBlocks.findIndex((b) => b.id === mut.block.id);
    if (childIdx === -1) continue;
    const previous = parentBlock.childBlocks[childIdx];
    const child = { ...previous };
    if (!applyBlockContentMutation(streamState, child, mut, databaseOwners)) {
      const stream = streamState.structuredToolStreams.get(child.id);
      if (stream) stream.owner = previous;
      return false;
    }
    parentBlock.childBlocks[childIdx] = child;
    // The child lives in a root block's subtree; its content changed in place
    // without a root ref swap, so the rootBlocks snapshot must still refresh.
    streamState.rootBlocksVersion += 1;
    return true;
  }
  return false;
}
