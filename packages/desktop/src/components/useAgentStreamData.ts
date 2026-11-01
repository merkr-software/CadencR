import { useMemo } from "react";
import { buildToolResultMap } from "./AgentBlock";
import type { AgentBlockData } from "@/types/agent-block";
import { buildDisplayItems, filterRenderableBlocks } from "@/lib/agent-stream-display";
import type { DisplayItem } from "@/types/agent-stream";
import { collapseTurnsToSummary } from "@/lib/agent-stream-summary";
import type { AgentVerbosityMode } from "@/lib/agent-verbosity";

export function useRootBlocks(
  blocks: AgentBlockData[],
  rootBlocks: AgentBlockData[] | undefined,
): AgentBlockData[] {
  return useMemo(
    () => rootBlocks ?? blocks.filter((block) => !block.parentToolUseId),
    [blocks, rootBlocks],
  );
}

export function useToolResultMap(
  blocks: AgentBlockData[],
  toolResultMap: Map<string, AgentBlockData> | undefined,
): Map<string, AgentBlockData> {
  const fallbackToolResultCount = useMemo(
    () =>
      toolResultMap
        ? 0
        : blocks.reduce((count, block) => count + (block.type === "tool_result" ? 1 : 0), 0),
    [blocks, toolResultMap],
  );
  const fallbackToolResultMap = useMemo(
    () => (toolResultMap ? new Map<string, AgentBlockData>() : buildToolResultMap(blocks)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: rebuild only when fallback result count changes
    [fallbackToolResultCount, toolResultMap],
  );
  return toolResultMap ?? fallbackToolResultMap;
}

export function useAgentDisplayItems(
  rootBlocks: AgentBlockData[],
  summaryMode: boolean,
  turnActive: boolean | undefined,
  isStreaming: boolean | undefined,
  verbosityMode: AgentVerbosityMode,
): { displayBlocks: AgentBlockData[]; displayItems: DisplayItem[] } {
  const displayBlocks = useMemo(() => {
    const filtered = filterRenderableBlocks(rootBlocks);
    if (!summaryMode) return filtered;
    return collapseTurnsToSummary(filtered, {
      activeStreaming: turnActive ?? !!isStreaming,
    });
  }, [isStreaming, rootBlocks, summaryMode, turnActive]);
  const displayItems = useMemo(
    () => buildDisplayItems(displayBlocks, { compact: verbosityMode === "compact" }),
    [displayBlocks, verbosityMode],
  );
  return useMemo(() => ({ displayBlocks, displayItems }), [displayBlocks, displayItems]);
}
