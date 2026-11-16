import type { AgentBlockData } from "@/types/agent-block";

/** Accept only positive, safe SQLite row ids at the live-event boundary. */
export function messageDbId(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) {
    return undefined;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function blockIdFromAgentMessage(msg: Record<string, unknown>): string | null {
  const id = messageDbId(msg.agent_message_id);
  return id === undefined ? null : `msg-${id}`;
}

export function messageDbIdFromBlockId(id: string): number | null {
  return id.startsWith("msg-") ? (messageDbId(id.slice(4)) ?? null) : null;
}
/** Numeric SQLite cursor carried explicitly or encoded in `msg-<id>`. */
export function blockMessageDbId(block: AgentBlockData): number | null {
  return messageDbId(block.messageDbId) ?? messageDbIdFromBlockId(block.id);
}
