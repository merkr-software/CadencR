import type { AgentBlockData } from "@/types/agent-block";
import { canRenderBashPreview } from "@/lib/bash-content-preview";
import { isSubagentToolName, shouldHideToolCall } from "@/lib/tool-display-policy";
import { isTaskTodoTool } from "@/lib/tool-adapter";

/**
 * Whether a tool result draws its own row. Results are otherwise folded into
 * their call (or hidden), so only subagent output and the errors of hidden
 * runtime tools stand alone.
 */
export function rendersStandaloneToolResult(block: AgentBlockData): boolean {
  if (block.isError && shouldHideToolCall(block.sourceToolName)) return true;
  return isSubagentToolName(block.sourceToolName);
}

/** Whether a tool call draws anything: runtime plumbing and todo updates never do. */
export function rendersToolCall(block: AgentBlockData): boolean {
  if (block.toolName === "TodoWrite" || isTaskTodoTool(block.toolName)) return false;
  return !shouldHideToolCall(block.toolName);
}

/**
 * Whether a bounded wire preview must stay inert until explicitly expanded.
 * Truncation never makes a block visible: a result the renderer hides (an MCP
 * screenshot's base64 payload, a large Read) stays hidden however big it is.
 */
export function shouldGateFullContent(block: AgentBlockData): boolean {
  if (block.truncatedContent !== true) return false;
  if (block.type === "tool_result" && !rendersStandaloneToolResult(block)) return false;
  if (block.type === "tool_call" && !rendersToolCall(block)) return false;
  if (block.type === "tool_call" && block.toolName === "Bash" && canRenderBashPreview(block))
    return false;
  return ["text", "code", "thinking", "error", "tool_call", "tool_result", "user_message"].includes(
    block.type,
  );
}
