import { memo, type ComponentProps, type ReactElement } from "react";
import { AgentStream } from "../AgentStream";
import type { AgentBlockData } from "@/types/agent-block";
import type { TurnLifecycle } from "@/stores/ws-turn-lifecycle";

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
  projectPath?: string;
  scrollContainerRef: AgentStreamProps["scrollContainerRef"];
  virtuosoRef: AgentStreamProps["virtuosoRef"];
  itemSize: AgentStreamProps["itemSize"];
  followOutput: AgentStreamProps["followOutput"];
  onAtBottomStateChange: (atBottom: boolean) => void;
  onTotalListHeightChanged: (height: number) => void;
  onStartReached: () => void;
  isLoadingOlder: boolean;
  historyPrependDisplayOffset?: number;
  verbosityMode: AgentStreamProps["verbosityMode"];
  summaryMode: AgentStreamProps["summaryMode"];
  searchEnabled: boolean;
  messageNavigator: AgentStreamProps["messageNavigator"];
}

export const AgentSessionStreamContent = memo(function AgentSessionStreamContent({
  blocks,
  rootBlocks,
  toolResultMap,
  isAgentWorking,
  turnActive,
  lifecycle,
  workingLabel,
  projectPath,
  scrollContainerRef,
  virtuosoRef,
  itemSize,
  followOutput,
  onAtBottomStateChange,
  onTotalListHeightChanged,
  onStartReached,
  isLoadingOlder,
  historyPrependDisplayOffset,
  verbosityMode,
  summaryMode,
  searchEnabled,
  messageNavigator,
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
      basePath={projectPath}
      scrollContainerRef={scrollContainerRef}
      virtuosoRef={virtuosoRef}
      itemSize={itemSize}
      followOutput={followOutput}
      onAtBottomStateChange={onAtBottomStateChange}
      onTotalListHeightChanged={onTotalListHeightChanged}
      onStartReached={onStartReached}
      isLoadingOlder={isLoadingOlder}
      historyPrependDisplayOffset={historyPrependDisplayOffset}
      verbosityMode={verbosityMode}
      summaryMode={summaryMode}
      searchEnabled={searchEnabled}
      messageNavigator={messageNavigator}
    />
  );
});
