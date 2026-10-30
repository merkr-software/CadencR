import type { AgentBlockData } from "@/types/agent-block";
import { isAgentSentMessage } from "@/lib/agent-message-origin";

/**
 * A side conversation's blocks without the brief the service wrote (the
 * source excerpt plus the question, sent as a generated message): the panel
 * already shows the question.
 */
export function withoutBrief(blocks: AgentBlockData[]): AgentBlockData[] {
  const brief = blocks.findIndex(isAgentSentMessage);
  return brief === -1 ? blocks : blocks.filter((_, index) => index !== brief);
}
