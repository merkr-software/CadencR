import type { AgentBlockData } from "@/types/agent-block";
import { isCountableTool } from "@/lib/agent-stream-summary";
import { isFileChangeTool, normalizeToolName } from "@/lib/tool-adapter";
import { mcpToolKey, parseMcpTool, type McpTool } from "@/lib/mcp-tool-parser";
import { semanticSkillPresentation } from "@/lib/tool-display-policy";
import { computeToolNumStat } from "@/lib/tool-numstat";
import type { ToolAccent } from "@/lib/tool-accent";

/**
 * One pill in the Summary-mode recap: a tool grouped by name, its run count, the
 * shared accent so it reads like the same tool everywhere, and — for file-change
 * tools — the aggregate `+A`/`-D` numstat across every call in the turn. MCP
 * tools carry their server so the pill can wear the brand badge + friendly label.
 */
export interface ToolChip {
  /** Grouping key (== normalized tool name; MCP raw names are already unique). */
  key: string;
  /** Display label — friendly MCP label, else the normalized tool name. */
  label: string;
  count: number;
  accent: ToolAccent;
  /** MCP server (browser / project / workspace) for the badge, if applicable. */
  mcpServer?: string;
  /** Aggregate added lines across the group (0 when not a file-change tool). */
  additions: number;
  /** Aggregate deleted lines across the group. */
  deletions: number;
}

function classifyAccent(name: string, mcp: McpTool | undefined): ToolAccent {
  if (mcp) return "mcp";
  if (name === "Bash") return "bash";
  if (isFileChangeTool(name)) return "edit";
  return "tool";
}

/**
 * Group a turn's countable tool calls into recap chips, preserving
 * first-appearance order. File-change groups accumulate their numstat from each
 * call's args; the heavier diff parse only runs for `edit`-accent groups.
 */
export function buildToolChips(blocks: AgentBlockData[]): ToolChip[] {
  const order: string[] = [];
  const groups = new Map<string, ToolChip>();

  for (const block of blocks) {
    if (!isCountableTool(block)) continue;
    const rawName = block.toolName ?? "unknown";
    const skill = semanticSkillPresentation(rawName, block.toolArgs);
    const name = skill ? "Skill" : normalizeToolName(rawName);
    const args = skill?.args ?? block.toolArgs;
    const mcpKey = mcpToolKey(rawName);
    const key = mcpKey ? `mcp:${mcpKey}` : name;

    let chip = groups.get(key);
    if (!chip) {
      const mcp = parseMcpTool(rawName, args);
      chip = {
        key,
        label: mcp?.label ?? name,
        count: 0,
        accent: classifyAccent(name, mcp),
        mcpServer: mcp?.server,
        additions: 0,
        deletions: 0,
      };
      groups.set(key, chip);
      order.push(key);
    }
    chip.count += 1;

    if (chip.accent === "edit") {
      const stats = computeToolNumStat(rawName, block.toolArgs);
      if (stats) {
        chip.additions += stats.additions;
        chip.deletions += stats.deletions;
      }
    }
  }

  return order.map((key) => groups.get(key)!);
}
