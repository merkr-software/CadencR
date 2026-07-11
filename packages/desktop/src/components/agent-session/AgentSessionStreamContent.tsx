import { memo, type ComponentProps, type ReactElement } from "react";
import { AgentStream } from "../AgentStream";
import type { AgentBlockData } from "../AgentBlock";
import type { TurnLifecycle } from "@/stores/ws-turn-lifecycle";

type AgentStreamProps = ComponentProps<typeof AgentStream>;

interface AgentSessionStreamContentProps {
  blocks: AgentBlockData[];
  rootBlocks?: AgentBlockData[];
  toolResultMap?: Map<string, AgentBlockData>;
  isAgentWorking: boolean;
  lifecycle?: TurnLifecycle;
  workingLabel: string;
  projectPath?: string;
  scrollContainerRef: AgentStreamProps["scrollContainerRef"];
  virtuosoRef: AgentStreamProps["virtuosoRef"];
  followOutput: AgentStreamProps["followOutput"];
  onAtBottomStateChange: (atBottom: boolean) => void;
  onTotalListHeightChanged: (height: number) => void;
  onStartReached: () => void;
  isLoadingOlder: boolean;
  historyPrependDisplayOffset?: number;
  verbosityMode: AgentStreamProps["verbosityMode"];
  summaryMode: AgentStreamProps["summaryMode"];
  searchEnabled: boolean;
}

export const AgentSessionStreamContent = memo(function AgentSessionStreamContent({
  blocks,
  rootBlocks,
  toolResultMap,
  isAgentWorking,
  lifecycle,
  workingLabel,
  projectPath,
  scrollContainerRef,
  virtuosoRef,
  followOutput,
  onAtBottomStateChange,
  onTotalListHeightChanged,
  onStartReached,
  isLoadingOlder,
  historyPrependDisplayOffset,
  verbosityMode,
  summaryMode,
  searchEnabled,
}: AgentSessionStreamContentProps): ReactElement | null {
  if (blocks.length === 0 && !isAgentWorking) return null;

  return (
    <AgentStream
      blocks={blocks}
      rootBlocks={rootBlocks}
      toolResultMap={toolResultMap}
      isStreaming={isAgentWorking}
      lifecycle={lifecycle}
      workingLabel={workingLabel}
      basePath={projectPath}
      scrollContainerRef={scrollContainerRef}
      virtuosoRef={virtuosoRef}
      followOutput={followOutput}
      onAtBottomStateChange={onAtBottomStateChange}
      onTotalListHeightChanged={onTotalListHeightChanged}
      onStartReached={onStartReached}
      isLoadingOlder={isLoadingOlder}
      historyPrependDisplayOffset={historyPrependDisplayOffset}
      verbosityMode={verbosityMode}
      summaryMode={summaryMode}
      searchEnabled={searchEnabled}
    />
  );
});
