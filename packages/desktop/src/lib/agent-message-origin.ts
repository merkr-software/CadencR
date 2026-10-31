import type { AgentMessageOrigin } from "@/api/generated";
import type { AgentBlockData } from "@/types/agent-block";
import { parseGeneratedSessionGate } from "@/lib/session-gate";
import { parseGeneratedSessionReply } from "@/lib/session-reply";

/** A user message another conversation's agent sent, rather than the person. */
export function isAgentSentMessage(
  block: AgentBlockData,
): block is AgentBlockData & { origin: AgentMessageOrigin } {
  return block.type === "user_message" && block.origin?.originKind === "session_generated";
}

/** `turn_interrupted` content the service writes when a restart cut the turn off. */
export const RESTART_INTERRUPTION = "restart";

/** `turn_interrupted` content for a turn the user stopped by quitting Cadencr. */
export const QUIT_INTERRUPTION = "quit";

/** The transcript marker of a turn a Cadencr restart cut off. */
export function isRestartInterruptionMarker(block: AgentBlockData): boolean {
  return block.type === "turn_interrupted" && block.content === RESTART_INTERRUPTION;
}

/** A marker the service wrote after it stopped mid-turn: a restart or a quit. */
export function isServiceStopMarker(block: AgentBlockData): boolean {
  return (
    isRestartInterruptionMarker(block) ||
    (block.type === "turn_interrupted" && block.content === QUIT_INTERRUPTION)
  );
}

/** `agent_message_origins.note` of the prompt Cadencr sends after a restart. */
const RESTART_CONTINUATION_NOTE = "restart_continuation";

/**
 * Cadencr's own "continue" prompt, sent when a restart (an app update, a
 * rebuild, a crash) cut the conversation's turn off — not the person's words.
 */
export function isRestartContinuationMessage(block: AgentBlockData): boolean {
  return (
    block.type === "user_message" &&
    block.origin?.originKind === "system_generated" &&
    block.origin.note === RESTART_CONTINUATION_NOTE
  );
}

/**
 * A message that carries its own name and time instead of the stream's
 * "User · time" line: one another agent sent (a plain bubble with a sender
 * tab), or Cadencr's restart continuation (a "Resumed after restart" divider).
 * Agent replies and gates render as their own cards instead (see
 * renderGeneratedSessionMessage).
 */
export function hasSenderTab(block: AgentBlockData): boolean {
  if (isRestartContinuationMessage(block)) return true;
  return (
    isAgentSentMessage(block) &&
    !parseGeneratedSessionReply(block.content, block.origin) &&
    !parseGeneratedSessionGate(block.content, block.origin)
  );
}
