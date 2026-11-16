import { memo, useMemo } from "react";
import { AgentBlock } from "../AgentBlock";
import type { AgentBlockData } from "@/types/agent-block";
import { hasSenderTab } from "@/lib/agent-message-origin";
import { shouldHideToolCall } from "@/lib/tool-display-policy";
import { formatStreamTimestamp } from "@/lib/date-utils";
import AgentStreamContextMenu from "./AgentStreamContextMenu";
import { ModelSwitchDivider, TURN_CLOSING_SPACING, TurnSummaryDivider } from "../StreamDividers";
import { parseGeneratedSessionReply } from "@/lib/session-reply";
import type { AgentVerbosityMode } from "@/lib/agent-verbosity";
import { useFoldPolicy } from "./useFoldPolicy";

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
 * Compact flow keeps the hover actions in flow (`actionsInFlow`), so a prompt
 * or prose and its action line together take the same gap on both sides.
 */
function rowSpacingClass(block: AgentBlockData, actionsInFlow: boolean): string {
  if (block.type === "user_message") return actionsInFlow ? "pt-6 pb-6" : "pt-6 pb-5";
  if (block.type === "text" || rendersResultAsProse(block)) {
    return actionsInFlow ? "pt-3 pb-3" : "pt-3 pb-3.5";
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

export const AgentStreamItem = memo(function AgentStreamItem({
  block,
  isStreaming,
  basePath,
  toolResultMap,
  verbosityMode = "maximal",
}: AgentStreamItemProps) {
  const { collapsed: collapsedByPolicy, onExpandedChange: handleExpandedChange } = useFoldPolicy({
    block,
    isStreaming: isStreaming === true,
    toolResultMap,
    verbosityMode,
  });

  const sessionReply = useMemo(
    () =>
      block.type === "user_message"
        ? parseGeneratedSessionReply(block.content, block.origin)
        : null,
    [block.content, block.origin, block.type],
  );
  const isSessionReply = sessionReply !== null;
  const showHeader = !isSessionReply && block.type === "user_message" && !hasSenderTab(block);

  // Compact flow's one-line steps sit tight under a message: an action line
  // floating over that gap would land on (or crowd) the next step.
  const actionsInFlow = verbosityMode === "compact";
  const item = (
    <div
      className={rowSpacingClass(block, actionsInFlow)}
      data-block-id={block.id}
      data-stream-actions-in-flow={actionsInFlow || undefined}
    >
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
