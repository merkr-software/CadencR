import { useState, useCallback, memo, useMemo } from "react";
import { cn, toRelativePath } from "@/lib/utils";
import { ChevronRightIcon, WrenchIcon, CopyIcon, CheckIcon } from "lucide-react";
import {
  isCadencrPlanPresentationTool,
  parseCadencrMcpTool,
  parseToolCall,
} from "@/lib/tool-call-parser";
import {
  extractBashCommand,
  extractBashOutput,
  extractBashResultOutput,
  isFileChangeTool,
  isToolCallRunning,
  normalizeToolName,
} from "@/lib/tool-adapter";
import { CadencrMcpBlock } from "@/components/CadencrMcpBlock";
import { Markdown } from "@/components/Markdown";
import { renderFileChangeBlocks } from "@/components/file-change-block";
import { UserMessageBlock } from "@/components/UserMessageBlock";
import { TaskAgentBlock } from "@/components/TaskAgentBlock";
import { PlanBlock } from "@/components/PlanBlock";
import { BashBlock } from "@/components/BashBlock";
import { ThinkingBlock } from "@/components/ThinkingBlock";
import { CompactDivider, ClearDivider, TurnSummaryDivider } from "@/components/StreamDividers";
import { ErrorBlock } from "@/components/ErrorBlock";
import { CodeBlockHeader } from "@/components/CodeBlockHeader";
import { useCodeBlockActions } from "@/components/CodeBlockActionsContext";
import { isTaskTodoTool } from "@/lib/tool-adapter";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";
import { verbosityControlsCollapse, type AgentVerbosityMode } from "@/lib/agent-verbosity";
import type { PromptDeliveryState } from "@/types/agent";
import type { AgentMessageOrigin } from "@/api/generated";

/** Block types that the agent stream can produce */
export type BlockType =
  | "text"
  | "code"
  | "tool_call"
  | "tool_result"
  | "thinking"
  | "user_message"
  | "turn_summary"
  | "compact_divider"
  | "clear_divider"
  | "error";

/** Build a lookup map from toolUseId → tool_result block. */
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
  /** Child blocks nested under this Task block */
  childBlocks?: AgentBlockData[];
  /** Whether this Task's subagent has completed */
  taskComplete?: boolean;
  /** DB message ID — used for deduplication against server data */
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
  /** Whether the parent agent is still streaming */
  isStreaming?: boolean;
  /** Base path to strip from file paths in diffs */
  basePath?: string;
  /** Map of toolUseId → tool_result block for inlining results into tool_call blocks */
  toolResultMap?: Map<string, AgentBlockData>;
  verbosityMode?: AgentVerbosityMode;
  isCollapsedByPolicy?: boolean;
  onExpandedChange?: (next: boolean) => void;
}

export const AgentBlock = memo(function AgentBlock({
  block,
  isStreaming,
  basePath,
  toolResultMap,
  verbosityMode = "maximal",
  isCollapsedByPolicy = false,
  onExpandedChange,
}: AgentBlockProps) {
  // Always thread a cache key — including the actively streaming block — so
  // Virtuoso re-renders that don't change the markdown content (size measure
  // passes, sibling re-renders, panel resizes) reuse the cached React tree
  // instead of re-running `lowlight.highlight` synchronously on every commit.
  // The cache itself is content-keyed and LRU-bounded in `Markdown.tsx`, so
  // streaming snapshots evict older entries cleanly.
  const markdownCacheKey = block.id;
  // `controlledExpanded` is the value threaded into the auto-collapsible
  // child blocks (Bash, file-change tools, thinking). `undefined` lets each
  // block keep its own internal state (Maximal / Compact modes); a boolean
  // takes over and the parent owns the fold (Auto-collapse / Collapsed).
  const controlledExpanded = verbosityControlsCollapse(verbosityMode)
    ? !isCollapsedByPolicy
    : undefined;
  switch (block.type) {
    case "text":
      return <TextBlock content={block.content} cacheKey={markdownCacheKey} />;
    case "code":
      return <CodeBlock content={block.content} language={block.language} />;
    case "tool_call": {
      if (block.toolName === "TodoWrite" || isTaskTodoTool(block.toolName)) return null;
      if ((block.toolName === "Task" || block.toolName === "Agent") && block.childBlocks) {
        return <TaskAgentBlock block={block} isStreaming={isStreaming} basePath={basePath} />;
      }
      if (
        block.toolName === "ExitPlanMode" ||
        (isPlanPresentationTool(block.toolName) && hasAttachedPlanContent(block.toolArgs))
      ) {
        return <PlanBlock args={block.toolArgs} approvalStatus={block.planApprovalStatus} />;
      }
      // Bash: unified block with command header + output body
      if (block.toolName === "Bash") {
        const result = block.toolUseId ? toolResultMap?.get(block.toolUseId) : undefined;
        const running = !result && isToolCallRunning(block.toolArgs);
        const resultOutput = result ? extractBashResultOutput(result.content) : undefined;
        const rawCommand = extractBashCommand(block.toolArgs);
        return (
          <BashBlock
            command={rawCommand ? toRelativePath(rawCommand, basePath) : rawCommand}
            content={resultOutput ?? extractBashOutput(block.toolArgs)}
            running={running}
            isError={result?.isError}
            messageId={result ? messageIdFromBlockId(result.id) : undefined}
            truncatedContent={result?.truncatedContent === true}
            expanded={controlledExpanded}
            onExpandedChange={onExpandedChange}
          />
        );
      }
      // Edit/Write: unified diff block (no separate ToolCallBlock header)
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
        <ToolCallBlock
          name={block.toolName ?? "unknown"}
          args={block.toolArgs}
          basePath={basePath}
        />
      );
    }
    case "tool_result": {
      // Bash results are inlined into the tool_call block — skip standalone rendering
      if (block.sourceToolName === "Bash") {
        return null;
      }
      // Edit/Write results are already shown via the diff — skip
      if (isFileChangeTool(block.sourceToolName)) {
        return null;
      }
      if (block.sourceToolName === "Agent" || block.sourceToolName === "Task") {
        return <AgentResultBlock content={block.content} />;
      }
      // Hide generic tool results (Grep, Read, Glob, etc.) to reduce noise.
      return null;
    }
    case "thinking":
      return (
        <ThinkingBlock
          content={block.content}
          cacheKey={markdownCacheKey}
          expanded={controlledExpanded}
          onExpandedChange={onExpandedChange}
        />
      );
    case "user_message":
      return (
        <UserMessageBlock
          content={block.content}
          origin={block.origin}
          deliveryState={
            block.promptDeliveryState === "pending_agent" ? block.promptDeliveryState : undefined
          }
        />
      );
    case "turn_summary":
      return <TurnSummaryDivider content={block.content} />;
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

function isPlanPresentationTool(toolName: string | undefined): boolean {
  return toolName === "ExitPlanMode" || isCadencrPlanPresentationTool(toolName);
}

function messageIdFromBlockId(id: string): number | undefined {
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
}: {
  content: string;
  cacheKey?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  return (
    <div className="group/textblock">
      <Markdown content={content} cacheKey={cacheKey} />
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

function ToolCallBlock({
  name,
  args,
  basePath,
}: {
  name: string;
  args?: string;
  basePath?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const canonicalName = normalizeToolName(name);
  const cadencrMcp = parseCadencrMcpTool(canonicalName, args);
  if (cadencrMcp) return <CadencrMcpBlock mcp={cadencrMcp} args={args} />;

  const summary = parseToolCall(canonicalName, args);
  const detail =
    summary?.detail && basePath ? toRelativePath(summary.detail, basePath) : summary?.detail;
  // File-patch tools (Edit / Write / ApplyPatch) get a distinct green "file
  // change" identity so they stand apart from generic tool calls, which keep the
  // neutral tool accent. The green is derived from each theme's --numstat-add-fg
  // (the diff "lines added" color), so it stays distinct in every theme without
  // per-theme tuning.
  const isEdit = isFileChangeTool(canonicalName);
  const toolColorClass = isEdit
    ? "text-[var(--numstat-add-fg)]"
    : "text-[var(--block-tool-accent)]";
  const wrapperClass = isEdit
    ? "border-[color-mix(in_srgb,var(--numstat-add-fg)_35%,transparent)] bg-[color-mix(in_srgb,var(--numstat-add-fg)_12%,var(--card))]"
    : "border-border bg-[var(--block-tool-bg)]";

  return (
    <div className={cn("my-1 rounded-md border", wrapperClass)}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
        onClick={() => setExpanded(!expanded)}
      >
        <WrenchIcon className={cn("size-3", toolColorClass)} />
        <span className={cn("font-medium", toolColorClass)}>{canonicalName}</span>
        {detail && <span className="truncate text-muted-foreground">{detail}</span>}
        <ChevronRightIcon
          className={cn(
            "ml-auto size-3 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && args && (
        <pre className="border-t border-border bg-muted/30 p-3 text-xs overflow-x-auto">
          {formatJson(args)}
        </pre>
      )}
    </div>
  );
}

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
