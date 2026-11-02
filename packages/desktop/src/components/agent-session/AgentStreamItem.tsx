import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentBlock } from "../AgentBlock";
import type { AgentBlockData } from "@/types/agent-block";
import { hasSenderTab } from "@/lib/agent-message-origin";
import { shouldHideToolCall } from "@/lib/tool-display-policy";
import { formatStreamTimestamp } from "@/lib/date-utils";
import AgentStreamContextMenu from "./AgentStreamContextMenu";
import { ModelSwitchDivider, TURN_CLOSING_SPACING, TurnSummaryDivider } from "../StreamDividers";
import { parseGeneratedSessionReply } from "@/lib/session-reply";
import {
  AGENT_AUTO_COLLAPSE_DELAY_MS,
  isToolAutoCollapsible,
  verbosityControlsCollapse,
  type AgentVerbosityMode,
} from "@/lib/agent-verbosity";

interface AgentStreamItemProps {
  block: AgentBlockData;
  isStreaming?: boolean;
  basePath?: string;
  toolResultMap: Map<string, AgentBlockData>;
  verbosityMode?: AgentVerbosityMode;
}

/**
 * "User · time" over a prompt. Replies carry no header: the model a turn ran
 * on and how long it took are said once, on its closing line
 * (`TurnSummaryDivider`), and a model switch gets its own divider row.
 */
function UserHeader({ createdAt }: { createdAt: string }) {
  return (
    <div className="mb-0.5 text-right text-xs text-muted-foreground/60">
      <span className="font-medium">User</span>
      {` · ${formatStreamTimestamp(createdAt)}`}
    </div>
  );
}

/**
 * Vertical rhythm, measured between what is visible (hover actions float over
 * the gap on hover devices, so they never count). Work steps — cards, compact
 * lines, markers — stack tight. Prose breathes the same on both sides. A
 * prompt opens a turn with the widest gap, the same above its "User" line as
 * under its bubble. The turn's closing line sits one prose gap under the turn.
 */
function rowSpacingClass(block: AgentBlockData): string {
  if (block.type === "user_message") return "pt-6 pb-5";
  if (block.type === "text" || rendersResultAsProse(block)) {
    return "pt-3 pb-3.5";
  }
  if (block.type === "turn_summary") return TURN_CLOSING_SPACING;
  return "py-0.5";
}

/**
 * A standalone tool result row renders a sub-agent's report as prose, hover
 * actions included — unless it is a hidden tool's error (`ToolResultContent`).
 */
function rendersResultAsProse(block: AgentBlockData): boolean {
  return (
    block.type === "tool_result" && !(block.isError && shouldHideToolCall(block.sourceToolName))
  );
}

/**
 * A block "finishes" on different signals depending on its type:
 *
 *   - `tool_call`: as soon as the matching `tool_result` arrives (the tool
 *     actually ran). The auto-collapse timer starts on result-arrival, NOT
 *     when the agent moves on to the next block — which matches the spec
 *     "3 seconds after they ran" and feels right for long-running Bash.
 *   - `thinking`:  when the streaming cursor moves off the block.
 *
 * Other block types never participate in auto-collapse.
 */
function isBlockFinished(
  block: AgentBlockData,
  isStreaming: boolean,
  toolResultMap: Map<string, AgentBlockData>,
): boolean {
  if (block.type === "thinking") return !isStreaming;
  if (block.type !== "tool_call") return false;
  if (!block.toolUseId) return !isStreaming;
  return toolResultMap.has(block.toolUseId);
}

export const AgentStreamItem = memo(function AgentStreamItem({
  block,
  isStreaming,
  basePath,
  toolResultMap,
  verbosityMode = "maximal",
}: AgentStreamItemProps) {
  const [collapsedByPolicy, setCollapsedByPolicy] = useState(false);

  const wasStreamingRef = useRef(false);
  if (isStreaming) wasStreamingRef.current = true;

  const blockId = block.id;
  const blockType = block.type;
  const toolName = block.type === "tool_call" ? block.toolName : undefined;
  const finished = isBlockFinished(block, !!isStreaming, toolResultMap);

  useEffect(() => {
    if (!verbosityControlsCollapse(verbosityMode)) {
      setCollapsedByPolicy(false);
      return;
    }
    // `isToolAutoCollapsible` covers Bash + file-change tools; thinking is
    // gated on block type because it isn't a tool call.
    const autoCollapsible =
      blockType === "thinking" || (blockType === "tool_call" && isToolAutoCollapsible(toolName));
    if (!autoCollapsible) {
      setCollapsedByPolicy(false);
      return;
    }
    // "Collapsed" mode folds blocks the moment they appear — no "just ran"
    // window, no streaming carve-out. User clicks still flow through
    // `onExpandedChange` and override this default.
    if (verbosityMode === "collapsed") {
      setCollapsedByPolicy(true);
      return;
    }
    if (!finished) {
      setCollapsedByPolicy(false);
      return;
    }
    if (!wasStreamingRef.current) {
      // Historical block (loaded as already-finished). No "just ran" window
      // to honor — collapse immediately so the cold-open stream is scannable.
      setCollapsedByPolicy(true);
      return;
    }
    const timer = setTimeout(() => setCollapsedByPolicy(true), AGENT_AUTO_COLLAPSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [blockId, blockType, toolName, finished, verbosityMode]);

  const handleExpandedChange = useCallback((next: boolean) => setCollapsedByPolicy(!next), []);

  const sessionReply = useMemo(
    () =>
      block.type === "user_message"
        ? parseGeneratedSessionReply(block.content, block.origin)
        : null,
    [block.content, block.origin, block.type],
  );
  const isSessionReply = sessionReply !== null;
  const showHeader = !isSessionReply && block.type === "user_message" && !hasSenderTab(block);

  const item = (
    <div className={rowSpacingClass(block)} data-block-id={block.id}>
      {showHeader && block.createdAt && <UserHeader createdAt={block.createdAt} />}
      {block.type === "turn_summary" ? (
        <TurnSummaryDivider content={block.content} />
      ) : block.type === "model_switch" ? (
        <ModelSwitchDivider content={block.content} />
      ) : (
        <AgentBlock
          block={block}
          isStreaming={isStreaming}
          basePath={basePath}
          toolResultMap={toolResultMap}
          verbosityMode={verbosityMode}
          isCollapsedByPolicy={collapsedByPolicy}
          onExpandedChange={handleExpandedChange}
          sessionReply={sessionReply}
        />
      )}
    </div>
  );
  return (
    <AgentStreamContextMenu
      block={block}
      copyContent={sessionReply?.body}
      branchingEnabled={!isSessionReply}
    >
      {item}
    </AgentStreamContextMenu>
  );
});
