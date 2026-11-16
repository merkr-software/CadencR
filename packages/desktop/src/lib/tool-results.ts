import type { AgentBlockData } from "@/types/agent-block";

/** `toolUseId` → the call's `tool_result`, as a stream or a sub-agent keeps them. */
export type ToolResults = ReadonlyMap<string, AgentBlockData>;

export function buildToolResultMap(blocks: AgentBlockData[]): Map<string, AgentBlockData> {
  const map = new Map<string, AgentBlockData>();
  for (const block of blocks) {
    if (block.type === "tool_result" && block.toolUseId) map.set(block.toolUseId, block);
  }
  return map;
}

/** The result of `block`'s call, when it has one. */
export function toolResultOf(
  toolResults: ToolResults | undefined,
  block: AgentBlockData,
): AgentBlockData | undefined {
  return block.toolUseId ? toolResults?.get(block.toolUseId) : undefined;
}
