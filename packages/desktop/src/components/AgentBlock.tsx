import { memo, useMemo, type ReactNode } from "react";
import { AgentResultBlock, CodeBlock, TextBlock } from "@/components/AgentTextBlocks";
import { toRelativePath } from "@/lib/utils";
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
import { renderFileChangeBlocks } from "@/components/file-change-block";
import { UserMessageBlock } from "@/components/UserMessageBlock";
import { AgentMessageSender } from "@/components/AgentMessageSender";
import { isAgentSentMessage, isRestartContinuationMessage } from "@/lib/agent-message-origin";
import { renderGeneratedSessionMessage } from "@/components/session-generated-message";
import { UserMessageActions } from "@/components/agent-session/UserMessageActions";
import { TaskAgentBlock } from "@/components/TaskAgentBlock";
import { PlanBlock } from "@/components/PlanBlock";
import { BashBlock } from "@/components/BashBlock";
import { ThinkingBlock } from "@/components/ThinkingBlock";
import { TurnSummaryDivider } from "@/components/StreamDividers";
import { TranscriptMarker } from "@/components/agent-session/TranscriptMarker";
import { ToolSummaryBlock } from "@/components/agent-session/ToolSummaryBlock";
import { ErrorBlock } from "@/components/ErrorBlock";
import { RestartResumedDivider } from "@/components/TurnInterruptedMarker";
import { FullContentPreview, type FullContentMode } from "@/components/FullContentPreview";
import { CompactToolLine } from "@/components/agent-session/CompactToolLine";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";
import {
  isSubagentCarrier,
  semanticSkillPresentation,
  shouldHideToolCall,
} from "@/lib/tool-display-policy";
import { verbosityControlsCollapse, type AgentVerbosityMode } from "@/lib/agent-verbosity";
import { blockMessageDbId } from "@/stores/ws-message-identity";
import type { SessionReplyEnvelope } from "@/lib/session-reply";

export type { AgentBlockData, BlockType } from "@/types/agent-block";
import {
  rendersStandaloneToolResult,
  rendersToolCall,
  shouldGateFullContent,
} from "@/lib/agent-block-content";
import type { AgentBlockData } from "@/types/agent-block";

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
  /** `preview`: a truncated wire preview, drawn without copy/retry actions. */
  contentMode?: "normal" | "preview" | "loaded-full";
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
  const actions = contentMode !== "preview";
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
    return (
      <TruncatedAgentBlock
        block={block}
        isStreaming={isStreaming}
        basePath={basePath}
        toolResultMap={toolResultMap}
        verbosityMode={verbosityMode}
        isCollapsedByPolicy={isCollapsedByPolicy}
        onExpandedChange={onExpandedChange}
        sessionReply={sessionReply}
      />
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
          actions={actions}
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
          compact={verbosityMode === "compact"}
        />
      );
    case "tool_result":
      return <ToolResultContent block={block} actions={actions} />;
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
      return <UserMessageContent block={block} sessionReply={sessionReply} actions={actions} />;
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
    case "clear_divider":
    case "turn_interrupted":
    case "error":
      return <TranscriptMarker block={block} />;
    default:
      return null;
  }
});

/** Prose past this sits under the preview mask anyway; parsing it only costs. */
const PROSE_PREVIEW_CHARS = 16 * 1024;

/** A bounded wire preview: its own renderer on the preview, the rest on demand. */
function TruncatedAgentBlock(props: Omit<AgentBlockProps, "contentMode">) {
  const { block, verbosityMode = "maximal", isCollapsedByPolicy = false } = props;
  return (
    <FullContentPreview
      preview={block.content}
      messageId={blockMessageDbId(block) ?? undefined}
      fullBytes={block.fullContentBytes}
      // A card the policy folded shows nothing a "Show all" would change.
      hideLine={verbosityControlsCollapse(verbosityMode) && isCollapsedByPolicy}
    >
      {(content, mode) => <TruncatedBlockBody {...props} content={content} mode={mode} />}
    </FullContentPreview>
  );
}

function TruncatedBlockBody({
  content,
  mode,
  ...props
}: Omit<AgentBlockProps, "contentMode"> & { content: string; mode: FullContentMode }) {
  const { block, basePath } = props;
  const shown = useMemo<AgentBlockData>(() => {
    if (mode === "full") {
      const toolArgs = block.type === "tool_call" ? content : block.toolArgs;
      return { ...block, content, toolArgs, truncatedContent: false };
    }
    const prose = block.type === "text" || block.type === "thinking";
    return {
      ...block,
      content: prose ? sliceUtf16(block.content, PROSE_PREVIEW_CHARS) : block.content,
      truncatedContent: false,
    };
  }, [block, content, mode]);
  // A cut edit would draw a wrong diff: its preview is the name only.
  if (mode === "preview" && block.type === "tool_call" && isFileChangeTool(block.toolName)) {
    return <CompactToolLine block={block} basePath={basePath} />;
  }
  return (
    <AgentBlock
      {...props}
      block={shown}
      isStreaming={mode === "preview" && props.isStreaming}
      contentMode={mode === "full" ? "loaded-full" : "preview"}
    />
  );
}

/** `slice` without leaving a lone high surrogate at the cut. */
function sliceUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

interface ToolCallContentProps {
  block: AgentBlockData;
  basePath?: string;
  toolResultMap?: Map<string, AgentBlockData>;
  controlledExpanded?: boolean;
  onExpandedChange?: (next: boolean) => void;
  /** Compact flow: sub-agents keep one line until opened. */
  compact?: boolean;
}

function ToolCallContent({
  block,
  basePath,
  toolResultMap,
  controlledExpanded,
  onExpandedChange,
  compact,
}: ToolCallContentProps): ReactNode {
  if (!rendersToolCall(block)) return null;
  const skill = semanticSkillPresentation(block.toolName, block.toolArgs);
  if (skill) return <ToolCallBlock name="Skill" args={skill.args} basePath={basePath} />;
  if (isSubagentCarrier(block)) {
    return <TaskAgentBlock block={block} basePath={basePath} compact={compact} />;
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
  actions,
}: {
  block: AgentBlockData;
  actions: boolean;
}): ReactNode {
  if (!rendersStandaloneToolResult(block)) return null;
  if (block.isError && shouldHideToolCall(block.sourceToolName)) {
    return <ErrorBlock content={block.content} />;
  }
  return <AgentResultBlock content={block.content} actions={actions} />;
}

function UserMessageContent({
  block,
  sessionReply,
  actions,
}: {
  block: AgentBlockData;
  sessionReply?: SessionReplyEnvelope | null;
  /** Off for a truncated preview: Retry would resend it without its images. */
  actions: boolean;
}): ReactNode {
  if (isRestartContinuationMessage(block))
    return <RestartResumedDivider sentAt={block.createdAt} />;
  const generated = renderGeneratedSessionMessage(block.content, block.origin, sessionReply);
  if (generated) return generated;
  return (
    <UserMessageBlock
      content={block.content}
      senderTab={
        isAgentSentMessage(block) ? (
          <AgentMessageSender origin={block.origin} sentAt={block.createdAt} />
        ) : undefined
      }
      deliveryState={block.promptDeliveryState}
      renderActions={
        actions
          ? (bubbleRef) => <UserMessageActions block={block} bubbleRef={bubbleRef} />
          : undefined
      }
    />
  );
}

function isPlanPresentationTool(toolName: string | undefined): boolean {
  return toolName === "ExitPlanMode" || isCadencrPlanPresentationTool(toolName);
}

function hasAttachedPlanContent(args: string | undefined): boolean {
  return !!stringArg(parseToolArgsObject(args), "plan");
}
