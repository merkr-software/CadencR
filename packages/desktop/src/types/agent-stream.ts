import type { AgentBlockData } from "@/types/agent-block";

/**
 * A renderable row in the agent stream. In every mode except "compact" each
 * block is its own row. In "compact" mode, each run of consecutive non-text
 * blocks (tool calls, thinking) folds into one `flow` row that renders as a
 * single line until the user unfolds it.
 */
export type DisplayItem =
  | { kind: "block"; key: string; block: AgentBlockData }
  | { kind: "flow"; key: string; blocks: AgentBlockData[] };

/**
 * Which display transforms are active, so row counts match what `AgentStream`
 * actually renders. Both default to off (Maximal, no summary).
 */
export interface DisplayRowMode {
  summaryMode?: boolean;
  compactMode?: boolean;
}
