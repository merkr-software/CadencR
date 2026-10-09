import { useState, useCallback, memo, useMemo, useRef, type ReactNode } from "react";
import { toRelativePath } from "@/lib/utils";
import { CopyIcon, CheckIcon } from "lucide-react";
import { isCadencrPlanPresentationTool } from "@/lib/tool-call-parser";
import {
  extractBashCommand,
  extractBashOutput,
  extractBashResultOutput,
  isFileChangeTool,
  isToolCallRunning,
  isToolCallError,
} from "@/lib/tool-adapter";
import { ToolCallBlock } from "@/components/AgentToolCallBlock";
import { Markdown } from "@/components/Markdown";
import { useStreamingMarkdownThrottle } from "@/hooks/useStreamingMarkdownThrottle";
import { renderFileChangeBlocks } from "@/components/file-change-block";
import { UserMessageBlock } from "@/components/UserMessageBlock";
import { renderGeneratedSessionMessage } from "@/components/session-generated-message";
import { UserMessageActions } from "@/components/agent-session/UserMessageActions";
import { CopyAsMenu } from "@/components/agent-session/CopyAsMenu";
import { TaskAgentBlock } from "@/components/TaskAgentBlock";
import { PlanBlock } from "@/components/PlanBlock";
import { BashBlock } from "@/components/BashBlock";
import { ThinkingBlock } from "@/components/ThinkingBlock";
import { CompactDivider, ClearDivider, TurnSummaryDivider } from "@/components/StreamDividers";
import { ToolSummaryBlock } from "@/components/agent-session/ToolSummaryBlock";
import { ErrorBlock } from "@/components/ErrorBlock";
import { FullContentPreview } from "@/components/FullContentPreview";
import { CodeBlockHeader } from "@/components/CodeBlockHeader";
import { useCodeBlockActions } from "@/components/CodeBlockActionsContext";
import { copyAs } from "@/lib/markdown-export";
import { isTaskTodoTool } from "@/lib/tool-adapter";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";
import { semanticSkillPresentation, shouldHideToolCall } from "@/lib/tool-display-policy";
import { verbosityControlsCollapse, type AgentVerbosityMode } from "@/lib/agent-verbosity";
import { blockMessageDbId } from "@/stores/ws-message-identity";
import type { SessionReplyEnvelope } from "@/lib/session-reply";

export type { AgentBlockData, BlockType } from "@/components/agent-block-types";
import { shouldGateFullContent, type AgentBlockData } from "@/components/agent-block-types";

export function buildToolResultMap(blocks: AgentBlockData[]): Map<string, AgentBlockData> {
  const map = new Map<string, AgentBlockData>();
  for (const block of blocks) {
    if (block.type === "tool_result" && block.toolUseId) map.set(block.toolUseId, block);
  }
  return map;
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
  contentMode?: "normal" | "loaded-full";
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
  contentMode = "normal",
}: AgentBlockProps) {
  const loadedFullContent = contentMode === "loaded-full";
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
  if (shouldGateFullContent(block)) {
    const messageId = blockMessageDbId(block) ?? undefined;
    return (
      <FullContentPreview preview={block.content} messageId={messageId}>
        {(content) => (
          <AgentBlock
            block={{
              ...block,
              content,
              toolArgs: block.type === "tool_call" ? content : block.toolArgs,
              truncatedContent: false,
            }}
            isStreaming={false}
            basePath={basePath}
            toolResultMap={toolResultMap}
            verbosityMode={verbosityMode}
            isCollapsedByPolicy={isCollapsedByPolicy}
            onExpandedChange={onExpandedChange}
            sessionReply={sessionReply}
            contentMode="loaded-full"
          />
        )}
      </FullContentPreview>
    );
  }
  switch (block.type) {
    case "text":
      return (
        <TextBlock
          content={block.content}
          cacheKey={markdownCacheKey}
          isStreaming={isStreaming}
          disableCache={loadedFullContent}
        />
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
      return <ToolResultContent block={block} showGeneric={loadedFullContent} />;
    case "thinking":
      return (
        <ThinkingBlock
          content={block.content}
          cacheKey={markdownCacheKey}
          isStreaming={isStreaming}
          expanded={controlledExpanded}
          onExpandedChange={onExpandedChange}
          disableCache={loadedFullContent}
        />
      );
    case "user_message":
      return <UserMessageContent block={block} sessionReply={sessionReply} />;
    case "turn_summary":
      return <TurnSummaryDivider content={block.content} />;
    case "tool_summary":
      return (
        <ToolSummaryBlock
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
  if (shouldHideToolCall(block.toolName)) return null;
  const skill = semanticSkillPresentation(block.toolName, block.toolArgs);
  if (skill) return <ToolCallBlock name="Skill" args={skill.args} basePath={basePath} />;
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
    const outputBlock = result ?? block;
    const resultOutput = result ? extractBashResultOutput(result.content) : undefined;
    const rawCommand = extractBashCommand(block.toolArgs);
    return (
      <BashBlock
        command={rawCommand ? toRelativePath(rawCommand, basePath) : rawCommand}
        content={resultOutput ?? extractBashOutput(block.toolArgs)}
        running={!result && isToolCallRunning(block.toolArgs)}
        isError={result?.isError ?? isToolCallError(block.toolArgs)}
        messageId={blockMessageDbId(outputBlock) ?? undefined}
        truncatedContent={outputBlock.truncatedContent === true}
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

function ToolResultContent({
  block,
  showGeneric = false,
}: {
  block: AgentBlockData;
  showGeneric?: boolean;
}): ReactNode {
  if (block.sourceToolName === "Bash") return null;
  if (isFileChangeTool(block.sourceToolName) && !showGeneric) return null;
  if (block.isError && shouldHideToolCall(block.sourceToolName)) {
    return <ErrorBlock content={block.content} />;
  }
  if (block.sourceToolName === "Agent" || block.sourceToolName === "Task") {
    return <AgentResultBlock content={block.content} />;
  }
  if (!showGeneric) return null;
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">
      {block.content}
    </pre>
  );
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
      deliveryState={block.promptDeliveryState}
      renderActions={(bubbleRef) => <UserMessageActions block={block} bubbleRef={bubbleRef} />}
    />
  );
}

function isPlanPresentationTool(toolName: string | undefined): boolean {
  return toolName === "ExitPlanMode" || isCadencrPlanPresentationTool(toolName);
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
  disableCache,
}: {
  content: string;
  cacheKey?: string;
  isStreaming?: boolean;
  disableCache?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Throttle re-parse of the actively streaming block; copy always uses the
  // full latest content.
  const displayContent = useStreamingMarkdownThrottle(content, !!isStreaming);

  const handleCopy = useCallback(() => {
    void copyAs("markdown", content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  return (
    <div className="group/textblock" ref={rootRef}>
      <Markdown
        content={displayContent}
        cacheKey={cacheKey}
        isStreaming={isStreaming}
        disableCache={disableCache}
      />
      <div className="flex items-center gap-1 opacity-0 group-hover/textblock:opacity-100 transition-colors">
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
        {!isStreaming && <CopyAsMenu content={content} sourceRef={rootRef} />}
      </div>
    </div>
  );
});

const SHELL_LANGUAGES = new Set(["bash", "sh", "zsh", "shell", "console", "terminal"]);

function CodeBlock({ content, language }: { content: string; language?: string }) {
  const { sendToTerminal } = useCodeBlockActions();
  const isShell = !!language && SHELL_LANGUAGES.has(language);

  return (
    <div
      data-code-block
      className="my-1 rounded-md border border-border bg-muted/50 overflow-hidden group/codeblock"
    >
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
