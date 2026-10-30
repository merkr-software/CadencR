import type { AgentBlockData } from "@/types/agent-block";
import type { BlockMutation, StreamingState } from "./ws-message-processing-core";
import { getStreamSessionId } from "./ws-message-processing-core";
import { blockMessageDbId, messageDbId } from "./ws-message-identity";

export function trackAssistantContentBlocks(
  msg: Record<string, unknown>,
  state: StreamingState,
  mutations: BlockMutation[],
): void {
  const event = msg.event as Record<string, unknown> | undefined;
  if (!event) return;
  const session = getStreamSessionId(msg);
  const parent = typeof msg.parent_tool_use_id === "string" ? msg.parent_tool_use_id : null;
  let scopes = state.assistantContentBlocks.get(session);
  if (event.type === "message_start") {
    scopes?.delete(parent);
    return;
  }
  for (const mutation of mutations) {
    if (mutation.action !== "append" || !["text", "thinking"].includes(mutation.block.type))
      continue;
    // Healthy starts already carry a durable identity. Track only live blocks
    // forwarded without a saved row, which need the final snapshot's identity.
    if (blockMessageDbId(mutation.block) !== null) continue;
    if (typeof event.index !== "number") continue;
    state.unidentifiedContentIds.add(mutation.block.id);
    if (!scopes) {
      scopes = new Map();
      state.assistantContentBlocks.set(session, scopes);
    }
    let blocks = scopes.get(parent);
    if (!blocks) {
      blocks = new Map();
      scopes.set(parent, blocks);
    }
    blocks.set(event.index, { id: mutation.block.id, type: mutation.block.type });
  }
}

/** Retain live block keys and content while attaching the repaired database identity. */
export function identifyAssistantContent(
  msg: Record<string, unknown>,
  content: Array<Record<string, unknown>>,
  state: StreamingState,
): BlockMutation[] {
  const parent = typeof msg.parent_tool_use_id === "string" ? msg.parent_tool_use_id : null;
  const tracked = state.assistantContentBlocks.get(getStreamSessionId(msg))?.get(parent);
  if (!tracked || !content.some((block) => messageDbId(block.agent_message_id) !== undefined))
    return [];
  const allBlocks: AgentBlockData[] = [];
  const visit = (block: AgentBlockData): void => {
    allBlocks.push(block);
    block.childBlocks?.forEach(visit);
  };
  state.rootBlocks.forEach(visit);
  const heldById = new Map(allBlocks.map((block) => [block.id, block]));
  const databaseOwners = new Map(
    allBlocks.flatMap((block) => {
      const id = blockMessageDbId(block);
      return id === null ? [] : [[id, block.id] as const];
    }),
  );
  const stampedIds = content.map((block) => messageDbId(block.agent_message_id));
  const counts = new Map<number, number>();
  for (const id of stampedIds) if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  return content.flatMap((block, index): BlockMutation[] => {
    const expected = tracked.get(index);
    const held = expected ? heldById.get(expected.id) : undefined;
    const id = stampedIds[index];
    if (
      !expected ||
      (held && held.type !== block.type) ||
      expected.type !== block.type ||
      (held && (held.parentToolUseId ?? null) !== parent) ||
      id === undefined ||
      counts.get(id) !== 1
    )
      return [];
    const owner = databaseOwners.get(id);
    const previousId = held ? blockMessageDbId(held) : null;
    if (
      (owner !== undefined && owner !== expected.id) ||
      (previousId !== null && previousId !== id)
    )
      return [];
    if (previousId === id) return [];
    databaseOwners.set(id, expected.id);
    return [
      {
        action: "identify",
        block: { id: expected.id, type: expected.type, content: "", messageDbId: id },
      },
    ];
  });
}
