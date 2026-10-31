import type { AgentMessageOrigin } from "@/api/generated";
import type { PromptDeliveryState } from "@/types/agent";
import { canRenderBashPreview } from "@/lib/bash-content-preview";
import { isSubagentToolName, shouldHideToolCall } from "@/lib/tool-display-policy";
import { isTaskTodoTool } from "@/lib/tool-adapter";

export type BlockType =
  | "text"
  | "code"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "user_message"
  | "turn_summary"
  | "tool_summary"
  | "compact_divider"
  | "clear_divider"
  | "turn_interrupted"
  | "error";

export interface AgentBlockData {
  id: string;
  type: BlockType;
  content: string;
  /** For tool_call blocks */
  toolName?: string;
  /** For tool_call blocks — JSON string of arguments */
  toolArgs?: string;
  /** For tool_result blocks */
  isError?: boolean;
  /** For code blocks */
  language?: string;
  /** The tool_use_id from the SDK (for tool_call blocks) */
  toolUseId?: string;
  /** Parent tool_use_id if this block comes from a subagent */
  parentToolUseId?: string | null;
  /** Child blocks nested under this Task block, or a tool_summary's turn detail */
  childBlocks?: AgentBlockData[];
  /** Whether this Task's subagent has completed */
  taskComplete?: boolean;
  /**
   * Whether this Task's subagent runs in the background. Claude's harness may
   * launch a subagent asynchronously: the Agent tool returns an immediate
   * "Async agent launched" ack (not the real output), and the subagent's work
   * streams afterward, interleaved with the main agent. Such a subagent must
   * NOT be completed by its own tool_result (the ack) nor by a context switch
   * away from it — only `turn_complete` truly ends it.
   */
  taskBackground?: boolean;
  /** Persisted DB message id used for chronological ordering and branching. */
  messageDbId?: number;
  /** Stable Cadencr-owned logical identity for a persisted user message. */
  messageUuid?: string;
  /** The tool name that produced this tool_result (resolved from parent tool_call) */
  sourceToolName?: string;
  /** ISO timestamp from the DB message */
  createdAt?: string;
  /** Model name for assistant messages (e.g. "claude-opus-4-6") */
  model?: string;
  /** Plan approval status — set after user approves or rejects */
  planApprovalStatus?: "approved" | "rejected";
  /** Whether `content` was server-side truncated and needs full-content fetch on expand. */
  truncatedContent?: boolean;
  /** UTF-8 size of the complete content behind a truncated server preview. */
  fullContentBytes?: number;
  /** Receipt state for local user prompt blocks when a runtime supports it. */
  promptDeliveryState?: PromptDeliveryState;
  /** For `error` blocks — machine-readable code from the backend. */
  errorCode?: string;
  /** Provenance for machine-generated user messages. */
  origin?: AgentMessageOrigin | null;
  /** Keep compact-flow rows stable across a paginated history seam. */
  compactFlowBreakBefore?: true;
}

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
