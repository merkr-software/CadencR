import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useMemo } from "react";
import { AgentBlock } from "../AgentBlock";
import type { AgentBlockData } from "@/types/agent-block";
import { hasSenderTab } from "@/lib/agent-message-origin";
import { rendersResultAsProse } from "@/lib/agent-block-content";
import { formatStreamTimestamp } from "@/lib/date-utils";
import AgentStreamContextMenu from "./AgentStreamContextMenu";
import { ModelSwitchDivider, TurnSummaryDivider } from "../StreamDividers";
import { parseGeneratedSessionReply } from "@/lib/session-reply";
import type { AgentVerbosityMode } from "@/lib/agent-verbosity";
import { useFoldPolicy } from "./useFoldPolicy";

interface AgentStreamItemProps {
  block: AgentBlockData;
  isStreaming?: boolean;
  basePath?: string;
  toolResultMap: Map<string, AgentBlockData>;
  verbosityMode?: AgentVerbosityMode;
  /**
   * Padding under the row, from the transcript's rhythm (`spaceRows`). Rows
   * nested in a card have none and keep their own spacing.
   */
  spaceBelow?: number;
}

/**
 * "User · time" over a prompt. Replies carry no header: the model a turn ran
 * on and how long it took are said once, on its closing line
 * (`TurnSummaryDivider`), and a model switch gets its own divider row.
 */
function UserHeader({ createdAt }: { createdAt: string }) {
  const { t } = useUiTranslation();
  return (
    <div className="mb-0.5 text-right text-xs text-muted-foreground/60">
      <span className="font-medium">{t("conversation.stream.agentStreamItem.user", "User")}</span>
      {` · ${formatStreamTimestamp(createdAt)}`}
    </div>
  );
}

/**
 * A row nested in a card (a summary's turn detail) sits outside the
 * transcript's rhythm: steps stack tight, prose and prompts keep some room.
 */
function nestedRowClass(block: AgentBlockData): string {
  if (block.type === "user_message") return "pt-6 pb-5";
  if (block.type === "text" || rendersResultAsProse(block)) return "pt-3 pb-3.5";
  return "py-0.5";
}

export const AgentStreamItem = memo(function AgentStreamItem({
  block,
  isStreaming,
  basePath,
  toolResultMap,
  verbosityMode = "maximal",
  spaceBelow,
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

  const item = (
    <div
      className={spaceBelow === undefined ? nestedRowClass(block) : undefined}
      style={spaceBelow === undefined ? undefined : { paddingBottom: spaceBelow }}
      data-block-id={block.id}
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
