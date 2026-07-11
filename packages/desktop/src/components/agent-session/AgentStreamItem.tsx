import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format, isToday } from "date-fns";
import { AgentBlock, type AgentBlockData } from "../AgentBlock";
import { parseUTCDateTime } from "@/lib/date-utils";
import AgentStreamContextMenu from "./AgentStreamContextMenu";
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

function formatTimestamp(iso: string): string {
  const date = parseUTCDateTime(iso);
  if (isToday(date)) return format(date, "HH:mm");
  return format(date, "yyyy/MM/dd HH:mm");
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
  const showHeader =
    !isSessionReply &&
    (block.type === "text" || block.type === "user_message") &&
    !!block.createdAt;
  const isUserMessage = block.type === "user_message";

  const item = (
    <div className="py-0.5" data-block-id={block.id}>
      {showHeader && block.createdAt && (
        <div
          className={`text-xs text-muted-foreground/60 mt-2 mb-0.5 ${isUserMessage ? "text-right" : ""}`}
        >
          <span className="font-medium">{isUserMessage ? "User" : (block.model ?? "unknown")}</span>
          {" · "}
          {formatTimestamp(block.createdAt)}
        </div>
      )}
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
    </div>
  );
  if (isSessionReply) return item;
  return <AgentStreamContextMenu block={block}>{item}</AgentStreamContextMenu>;
});
