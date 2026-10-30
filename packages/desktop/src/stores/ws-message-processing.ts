/**
 * Pure functions for processing WebSocket SDK messages into block mutations.
 *
 * These are stateless transforms — they read/write a StreamingState struct
 * but never touch Zustand or the DOM.
 */

import type { AgentBlockData } from "@/types/agent-block";
import { isCadencrPlanPresentationTool } from "@/lib/tool-call-parser";

export { createStreamingState, isRecord, processSdkMessage } from "./ws-message-processing-core";
export type {
  BlockMutation,
  MessageProcessingResult,
  ParserSignals,
  StreamingState,
} from "./ws-message-processing-core";

// Re-export block mutation helpers for existing consumers
export {
  applyMutations,
  blocksPatchWithDerived,
  buildMessagePatch,
  parseTodosFromBlocks,
  rebuildDerivedAgentStreamState,
} from "./ws-block-mutations";
export type { MessagePatch, ParsedTodo } from "./ws-block-mutations";

// ---------------------------------------------------------------------------
// Plan injection for app restart
// ---------------------------------------------------------------------------

function isPlanToolCall(block: AgentBlockData): boolean {
  return (
    block.type === "tool_call" &&
    (block.toolName === "ExitPlanMode" || isCadencrPlanPresentationTool(block.toolName))
  );
}

/** Inject plan content from pendingPlanApproval into the last plan tool_call block's toolArgs. */
export function injectPlanIntoBlocks(
  blocks: AgentBlockData[],
  pendingPlanApproval: { plan?: string } | null | undefined,
): AgentBlockData[] {
  if (!pendingPlanApproval?.plan) return blocks;

  let targetIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isPlanToolCall(blocks[i])) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx === -1) return blocks;

  const block = blocks[targetIdx];
  try {
    const existing = JSON.parse(block.toolArgs ?? "{}") as Record<string, unknown>;
    if (typeof existing.plan === "string") return blocks;
    existing.plan = pendingPlanApproval.plan;
    const updated = [...blocks];
    updated[targetIdx] = { ...block, toolArgs: JSON.stringify(existing) };
    return updated;
  } catch {
    return blocks;
  }
}
