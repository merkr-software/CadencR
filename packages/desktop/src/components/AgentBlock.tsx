import { useState, useCallback, memo, useMemo, type ReactNode } from "react";
import { toRelativePath } from "@/lib/utils";
import { CopyIcon, CheckIcon } from "lucide-react";
import { isCadencrPlanPresentationTool } from "@/lib/tool-call-parser";
import {
  extractBashCommand,
  extractBashOutput,
  extractBashResultOutput,
  isFileChangeTool,
  isToolCallRunning,
} from "@/lib/tool-adapter";
import { ToolCallBlock } from "@/components/AgentToolCallBlock";
import { Markdown } from "@/components/Markdown";
import { useStreamingMarkdownThrottle } from "@/hooks/useStreamingMarkdownThrottle";
import { renderFileChangeBlocks } from "@/components/file-change-block";
import { UserMessageBlock } from "@/components/UserMessageBlock";
import { renderGeneratedSessionMessage } from "@/components/session-generated-message";
import { UserMessageActions } from "@/components/agent-session/UserMessageActions";
import { TaskAgentBlock } from "@/components/TaskAgentBlock";
import { PlanBlock } from "@/components/PlanBlock";
import { BashBlock } from "@/components/BashBlock";
import { ThinkingBlock } from "@/components/ThinkingBlock";
import { CompactDivider, ClearDivider, TurnSummaryDivider } from "@/components/StreamDividers";
import { ToolSummaryBlock } from "@/components/agent-session/ToolSummaryBlock";
import type { ToolSummaryCount } from "@/components/agentStreamSummary";
import { ErrorBlock } from "@/components/ErrorBlock";
import { CodeBlockHeader } from "@/components/CodeBlockHeader";
import { useCodeBlockActions } from "@/components/CodeBlockActionsContext";
import { isTaskTodoTool } from "@/lib/tool-adapter";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";
import { verbosityControlsCollapse, type AgentVerbosityMode } from "@/lib/agent-verbosity";
import type { PromptDeliveryState } from "@/types/agent";
import type { AgentMessageOrigin } from "@/api/generated";
import type { SessionReplyEnvelope } from "@/lib/session-reply";

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
  | "error";

export function buildToolResultMap(blocks: AgentBlockData[]): Map<string, AgentBlockData> {
  const map = new Map<string, AgentBlockData>();
  for (const b of blocks) {
    if (b.type === "tool_result" && b.toolUseId) map.set(b.toolUseId, b);
  }
  return map;
}

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
  /** Per-tool counts for a synthetic `tool_summary` recap block (in-memory only) */
  summaryCounts?: ToolSummaryCount[];
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
  /**
   * Persisted DB message id. For history-loaded blocks the id is encoded in
   * `id` (`msg-<n>`); for a message sent live this session (a `ws-user-*`
   * block) it is stamped here by the `prompt_persisted` ack so rewind/fork can
   * target it without a reload.
   */
  messageDbId?: number;
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
  /** Client-generated id for local prompt delivery tracking. */
  clientMessageId?: string;
  /** Receipt state for local user prompt blocks when a runtime supports it. */
  promptDeliveryState?: PromptDeliveryState;
  /** For `error` blocks — machine-readable code from the backend. */
  errorCode?: string;
  /** Provenance for machine-generated user messages. */
  origin?: AgentMessageOrigin | null;
}

interface AgentBlockProps {
  block: AgentBlockData;
  isStreaming?: boolean;
  basePath?: string;
  /** Map of toolUseId → tool_result block for inlining results into tool_call blocks */
  toolResultMap?: Map<string, AgentBlockData>;
  verbosityMode?: AgentVerbosityMode;
  isCollapsedByPolicy?: boolean;
  onExpandedChange?: (next: boolean) => void;
  sessionReply?: SessionReplyEnvelope | null;
}

export const AgentBlock = memo(function AgentBlock({
  block,
  isStreaming,
  basePath,
  toolResultMap,
  verbosityMode = "maximal",
  isCollapsedByPolicy = false,
  onExpandedChange,
  sessionReply,
}: AgentBlockProps) {
  // Cache the rendered markdown tree for STABLE blocks (keyed by block id) so
  // Virtuoso recycling reuses it across mounts. The actively streaming block is
  // deliberately NOT cached: its content changes every batch, so caching each
  // partial snapshot would churn the LRU with entries never read again. Its
  // re-parse is instead bounded by `useStreamingMarkdownThrottle` in the leaf
  // block, and the component-level `useMemo` already skips re-parsing on
  // content-preserving re-renders (size measure passes, resizes).
  const markdownCacheKey = isStreaming ? undefined : block.id;
  // `controlledExpanded` is the value threaded into the auto-collapsible
  // child blocks (Bash, file-change tools, thinking). `undefined` lets each
  // block keep its own internal state (Maximal / Compact modes); a boolean
  // takes over and the parent owns the fold (Auto-collapse / Collapsed).
  const controlledExpanded = verbosityControlsCollapse(verbosityMode)
    ? !isCollapsedByPolicy
    : undefined;
  switch (block.type) {
    case "text":
      return (
        <TextBlock content={block.content} cacheKey={markdownCacheKey} isStreaming={isStreaming} />
      );
    case "code":
      return <CodeBlock content={block.content} language={block.language} />;
    case "tool_call":
      return (
        <ToolCallContent
          block={block}
          basePath={basePath}
          toolResultMap={toolResultMap}
          controlledExpanded={controlledExpanded}
          onExpandedChange={onExpandedChange}
        />
      );
    case "tool_result":
      return <ToolResultContent block={block} />;
    case "thinking":
      return (
        <ThinkingBlock
          content={block.content}
          cacheKey={markdownCacheKey}
          isStreaming={isStreaming}
          expanded={controlledExpanded}
          onExpandedChange={onExpandedChange}
        />
      );
    case "user_message":
      return <UserMessageContent block={block} sessionReply={sessionReply} />;
    case "turn_summary":
      return <TurnSummaryDivider content={block.content} />;
    case "tool_summary":
      return (
        <ToolSummaryBlock
          counts={block.summaryCounts}
          childBlocks={block.childBlocks}
          basePath={basePath}
          toolResultMap={toolResultMap}
          verbosityMode={verbosityMode}
        />
      );
    case "compact_divider":
      return <CompactDivider metadata={block.content} />;
    case "clear_divider":
      return <ClearDivider previousSessionId={block.content} />;
    case "error":
      return <ErrorBlock content={block.content} code={block.errorCode} />;
    default:
      return null;
  }
});

interface ToolCallContentProps {
  block: AgentBlockData;
  basePath?: string;
  toolResultMap?: Map<string, AgentBlockData>;
  controlledExpanded?: boolean;
  onExpandedChange?: (next: boolean) => void;
}

function ToolCallContent({
  block,
  basePath,
  toolResultMap,
  controlledExpanded,
  onExpandedChange,
}: ToolCallContentProps): ReactNode {
  if (block.toolName === "TodoWrite" || isTaskTodoTool(block.toolName)) return null;
  if ((block.toolName === "Task" || block.toolName === "Agent") && block.childBlocks) {
    return <TaskAgentBlock block={block} basePath={basePath} />;
  }
  if (
    block.toolName === "ExitPlanMode" ||
    (isPlanPresentationTool(block.toolName) && hasAttachedPlanContent(block.toolArgs))
  ) {
    return <PlanBlock args={block.toolArgs} approvalStatus={block.planApprovalStatus} />;
  }
  if (block.toolName === "Bash") {
    const result = block.toolUseId ? toolResultMap?.get(block.toolUseId) : undefined;
    const resultOutput = result ? extractBashResultOutput(result.content) : undefined;
    const rawCommand = extractBashCommand(block.toolArgs);
    return (
      <BashBlock
        command={rawCommand ? toRelativePath(rawCommand, basePath) : rawCommand}
        content={resultOutput ?? extractBashOutput(block.toolArgs)}
        running={!result && isToolCallRunning(block.toolArgs)}
        isError={result?.isError}
        messageId={result ? messageIdFromBlockId(result.id) : undefined}
        truncatedContent={result?.truncatedContent === true}
        expanded={controlledExpanded}
        onExpandedChange={onExpandedChange}
      />
    );
  }
  if (isFileChangeTool(block.toolName)) {
    const fileChangeBlocks = renderFileChangeBlocks(
      block.toolName,
      block.toolArgs,
      basePath,
      controlledExpanded,
      onExpandedChange,
    );
    if (fileChangeBlocks) return fileChangeBlocks;
  }
  return (
    <ToolCallBlock name={block.toolName ?? "unknown"} args={block.toolArgs} basePath={basePath} />
  );
}

function ToolResultContent({ block }: { block: AgentBlockData }): ReactNode {
  if (block.sourceToolName === "Bash" || isFileChangeTool(block.sourceToolName)) return null;
  if (block.sourceToolName === "Agent" || block.sourceToolName === "Task") {
    return <AgentResultBlock content={block.content} />;
  }
  return null;
}

function UserMessageContent({
  block,
  sessionReply,
}: {
  block: AgentBlockData;
  sessionReply?: SessionReplyEnvelope | null;
}): ReactNode {
  const generated = renderGeneratedSessionMessage(block.content, block.origin, sessionReply);
  if (generated) return generated;
  return (
    <UserMessageBlock
      content={block.content}
      origin={block.origin}
      deliveryState={
        block.promptDeliveryState === "pending_agent" ? block.promptDeliveryState : undefined
      }
      actions={<UserMessageActions block={block} />}
    />
  );
}

function isPlanPresentationTool(toolName: string | undefined): boolean {
  return toolName === "ExitPlanMode" || isCadencrPlanPresentationTool(toolName);
}

export function messageIdFromBlockId(id: string): number | undefined {
  if (!id.startsWith("msg-")) return undefined;
  const parsed = Number(id.slice(4));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function hasAttachedPlanContent(args: string | undefined): boolean {
  return !!stringArg(parseToolArgsObject(args), "plan");
}

/** Render the final text output from an Agent/Task tool_result (JSON content blocks). */
function AgentResultBlock({ content }: { content: string }) {
  const text = useMemo(() => {
    try {
      const blocks = JSON.parse(content) as Array<{
        type?: string;
        text?: string;
      }>;
      return blocks
        .filter((b) => b.type === "text" || (!b.type && typeof b.text === "string"))
        .map((b) => b.text ?? "")
        .join("\n");
    } catch {
      return content;
    }
  }, [content]);
  if (!text) return null;
  return <TextBlock content={text} />;
}

const TextBlock = memo(function TextBlock({
  content,
  cacheKey,
  isStreaming,
}: {
  content: string;
  cacheKey?: string;
  isStreaming?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  // Throttle re-parse of the actively streaming block; copy always uses the
  // full latest content.
  const displayContent = useStreamingMarkdownThrottle(content, !!isStreaming);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  return (
    <div className="group/textblock">
      <Markdown content={displayContent} cacheKey={cacheKey} />
      <div className="opacity-0 group-hover/textblock:opacity-100 transition-colors">
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground/70 hover:bg-accent hover:text-foreground transition-colors"
          title="Copy to clipboard"
        >
          {copied ? (
            <>
              <CheckIcon className="size-3 text-green-400" />
              <span className="text-green-400">Copied</span>
            </>
          ) : (
            <>
              <CopyIcon className="size-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
});

const SHELL_LANGUAGES = new Set(["bash", "sh", "zsh", "shell", "console", "terminal"]);

function CodeBlock({ content, language }: { content: string; language?: string }) {
  const { sendToTerminal } = useCodeBlockActions();
  const isShell = !!language && SHELL_LANGUAGES.has(language);

  return (
    <div className="my-1 rounded-md border border-border bg-muted/50 overflow-hidden group/codeblock">
      {language && (
        <CodeBlockHeader
          language={language}
          code={content}
          showTerminalButton={isShell && !!sendToTerminal}
          onSendToTerminal={sendToTerminal}
        />
      )}
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code>{content}</code>
      </pre>
    </div>
  );
}
