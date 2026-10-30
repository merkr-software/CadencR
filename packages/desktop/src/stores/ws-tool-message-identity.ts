import type { AgentBlockData } from "@/types/agent-block";
import { blockMessageDbId } from "./ws-message-identity";

function toolKey(block: AgentBlockData): string | undefined {
  if (!block.toolUseId || !["tool_call", "tool_result"].includes(block.type)) return undefined;
  return JSON.stringify([block.type, block.toolUseId, block.parentToolUseId ?? null]);
}

function uniqueTools(blocks: AgentBlockData[]): Map<string, AgentBlockData | null> {
  const map = new Map<string, AgentBlockData | null>();
  for (const block of blocks) {
    const key = toolKey(block);
    if (key) map.set(key, map.has(key) ? null : block);
  }
  return map;
}

/** Repair old live identities only when both sides contain one unambiguous tool. */
export function recoverToolMessageIds(
  existing: AgentBlockData[],
  incoming: AgentBlockData[],
): AgentBlockData[] {
  const held = uniqueTools(existing);
  const persisted = uniqueTools(incoming);
  let changed = false;
  const result = existing.map((block) => {
    if (blockMessageDbId(block) != null) return block;
    const key = toolKey(block);
    if (!key || held.get(key) !== block) return block;
    const match = persisted.get(key);
    const id = match && blockMessageDbId(match);
    if (id == null) return block;
    changed = true;
    return { ...block, messageDbId: id };
  });
  return changed ? result : existing;
}
