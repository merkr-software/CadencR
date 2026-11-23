import { memo, type ComponentProps, type ReactElement } from "react";
import { AgentStream } from "../AgentStream";
import type { AgentBlockData } from "@/types/agent-block";
import type { TurnLifecycle } from "@/stores/ws-turn-lifecycle";
import type { TurnClock } from "@/lib/turn-clock";
import type { UseAgentSessionScrollResult } from "./agent-session-scroll-utils";

type AgentStreamProps = ComponentProps<typeof AgentStream>;

interface AgentSessionStreamContentProps {
  blocks: AgentBlockData[];
  rootBlocks?: AgentBlockData[];
  toolResultMap?: Map<string, AgentBlockData>;
  isAgentWorking: boolean;
  /** Turn still in flight (working OR paused on a question/permission). */
  turnActive: boolean;
  lifecycle?: TurnLifecycle;
  workingLabel: string;
  workingClock: TurnClock | null;
  projectPath?: string;
  /** The transcript's scroll wiring, history loading included. */
  scroll: UseAgentSessionScrollResult;
  historyPrependDisplayOffset?: number;
  historyGaps: AgentStreamProps["historyGaps"];
  verbosityMode: AgentStreamProps["verbosityMode"];
  summaryMode: AgentStreamProps["summaryMode"];
  searchEnabled: boolean;
  messageNavigator: AgentStreamProps["messageNavigator"];
  openingPreview: AgentStreamProps["openingPreview"];
}

export const AgentSessionStreamContent = memo(function AgentSessionStreamContent({
  blocks,
  rootBlocks,
  toolResultMap,
  isAgentWorking,
  turnActive,
  lifecycle,
  workingLabel,
  workingClock,
  projectPath,
  scroll,
  historyPrependDisplayOffset,
  historyGaps,
  verbosityMode,
  summaryMode,
  searchEnabled,
  messageNavigator,
  openingPreview,
}: AgentSessionStreamContentProps): ReactElement | null {
  if (blocks.length === 0 && !isAgentWorking) return null;

  return (
    <AgentStream
      blocks={blocks}
      rootBlocks={rootBlocks}
      toolResultMap={toolResultMap}
      isStreaming={isAgentWorking}
      turnActive={turnActive}
      lifecycle={lifecycle}
      workingLabel={workingLabel}
      workingClock={workingClock}
      basePath={projectPath}
      scrollContainerRef={scroll.scrollContainerRef}
      virtuosoRef={scroll.virtuosoRef}
      itemSize={scroll.itemSize}
      followOutput={scroll.followOutput}
      onAtBottomStateChange={scroll.onAtBottomStateChange}
      onTotalListHeightChanged={scroll.onTotalListHeightChanged}
      historyPrependDisplayOffset={historyPrependDisplayOffset}
      historyGaps={historyGaps}
      historyGapStatus={scroll.historyGapStatus}
      verbosityMode={verbosityMode}
      summaryMode={summaryMode}
      searchEnabled={searchEnabled}
      messageNavigator={messageNavigator}
      openingPreview={openingPreview}
    />
  );
});
