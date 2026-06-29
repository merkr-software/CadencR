import type { AgentBlockData } from "@/components/AgentBlock";
import type { PromptDeliveryState } from "@/types/agent";

export interface LocalUserMessageOptions {
  clientMessageId?: string;
  promptDeliveryState?: PromptDeliveryState;
  origin?: AgentBlockData["origin"];
}

export interface TailPromptTurnBoundary {
  blocks: AgentBlockData[];
  shouldTrim: boolean;
}

export function movePendingPromptBlocksToTail(blocks: AgentBlockData[]): AgentBlockData[] {
  const firstPending = blocks.findIndex(isPendingPromptBlock);
  if (firstPending === -1 || pendingBlocksAlreadyAtTail(blocks, firstPending)) {
    return blocks;
  }
  const stable: AgentBlockData[] = [];
  const pending: AgentBlockData[] = [];
  for (const block of blocks) {
    (isPendingPromptBlock(block) ? pending : stable).push(block);
  }
  return [...stable, ...pending];
}

export function markPromptReceived(
  blocks: AgentBlockData[],
  clientMessageId: string,
): AgentBlockData[] {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.clientMessageId !== clientMessageId) return block;
    changed = true;
    const received = { ...block };
    delete received.clientMessageId;
    received.promptDeliveryState = "received_agent";
    return received;
  });
  return changed ? next : blocks;
}

/**
 * Stamp the persisted DB message id onto the locally-appended user block
 * (matched by its `userMessageRef`, stored in `clientMessageId`). The optimistic
 * block carries a `ws-user-*` id with no DB id, so rewind/fork — which cut at a
 * persisted message id — stay hidden on it until reload; the id lets those
 * actions light up immediately. The block id is left untouched so the Virtuoso
 * row key is stable (no remount).
 */
export function stampPersistedMessageId(
  blocks: AgentBlockData[],
  userMessageRef: string,
  messageId: number,
): AgentBlockData[] {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.clientMessageId !== userMessageRef || block.messageDbId === messageId) return block;
    changed = true;
    return { ...block, messageDbId: messageId };
  });
  return changed ? next : blocks;
}

export function trimTailPromptTurnBoundary(blocks: AgentBlockData[]): TailPromptTurnBoundary {
  const promptIndex = lastPromptDeliveryBlockIndex(blocks);
  if (promptIndex === -1) {
    return { blocks, shouldTrim: false };
  }

  for (let index = promptIndex + 1; index < blocks.length; index += 1) {
    if (!isIgnorableTrailingPromptBlock(blocks[index])) {
      return { blocks, shouldTrim: false };
    }
  }

  return {
    blocks: promptIndex === blocks.length - 1 ? blocks : blocks.slice(0, promptIndex + 1),
    shouldTrim: true,
  };
}

export function removePendingPromptBlocks(blocks: AgentBlockData[]): AgentBlockData[] {
  if (!blocks.some(isPendingPromptBlock)) return blocks;
  const next = blocks.filter((block) => !isPendingPromptBlock(block));
  return next.length === blocks.length ? blocks : next;
}

function isPendingPromptBlock(block: AgentBlockData): boolean {
  return block.promptDeliveryState === "pending_agent";
}

function isPromptDeliveryBlock(block: AgentBlockData): boolean {
  return (
    block.type === "user_message" &&
    (block.promptDeliveryState === "pending_agent" ||
      block.promptDeliveryState === "received_agent")
  );
}

function isIgnorableTrailingPromptBlock(block: AgentBlockData): boolean {
  return block.type === "turn_summary";
}

function lastPromptDeliveryBlockIndex(blocks: AgentBlockData[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (isIgnorableTrailingPromptBlock(block)) continue;
    return isPromptDeliveryBlock(block) ? index : -1;
  }
  return -1;
}

function pendingBlocksAlreadyAtTail(blocks: AgentBlockData[], firstPending: number): boolean {
  for (let i = firstPending; i < blocks.length; i += 1) {
    if (!isPendingPromptBlock(blocks[i])) return false;
  }
  return true;
}
