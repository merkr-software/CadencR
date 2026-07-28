import {
  memo,
  useCallback,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
import { Loader2Icon } from "lucide-react";
import {
  Virtuoso,
  type Components,
  type FollowOutput,
  type ListRange,
  type VirtuosoHandle,
} from "react-virtuoso";
import type { AgentBlockData } from "./AgentBlock";
import { AgentStreamItem } from "./agent-session/AgentStreamItem";
import { CompactFlowRow } from "./agent-session/CompactFlowRow";
import { ConversationSearch } from "./agent-session/ConversationSearch";
import type { DisplayItem } from "./agentStreamDisplay";
import { useAgentDisplayItems, useRootBlocks, useToolResultMap } from "./useAgentStreamData";
import type { TurnLifecycle } from "@/stores/ws-turn-lifecycle";
import { isTurnInProgress } from "@/components/TurnWorkingLabel";
import type { AgentVerbosityMode } from "@/lib/agent-verbosity";

type ScrollRef = (el: HTMLElement | null) => void;
const FIRST_ITEM_INDEX_BASE = 1_000_000;
const HISTORY_PREFETCH_ROWS = 12;

interface AgentStreamVirtuosoContext {
  showStreamingIndicator: boolean;
  /**
   * Block id of the *currently* streaming item, or null when the session is
   * idle. Threaded through Virtuoso `context` (not closed over by
   * `renderItem`) so only items whose per-block `isStreaming` flag actually
   * flips bust their `React.memo` — older items stay stable across chunks
   * instead of re-rendering the entire list every time the cursor advances.
   */
  streamingBlockId: string | null;
  lifecycle?: TurnLifecycle;
  workingLabel: string;
}

interface AgentStreamProps {
  blocks: AgentBlockData[];
  /**
   * Pre-filtered subset of `blocks` excluding subagent children. When
   * provided, AgentStream uses it directly instead of recomputing the filter
   * on every render — the WS store maintains it incrementally. When omitted,
   * the stream falls back to filtering `blocks` itself.
   */
  rootBlocks?: AgentBlockData[];
  /**
   * Map from a tool_call's `toolUseId` to its `tool_result` block. Same
   * deal: provided by the WS store incrementally, falls back to a derived
   * map when omitted.
   */
  toolResultMap?: Map<string, AgentBlockData>;
  /** Whether the agent is currently streaming */
  isStreaming?: boolean;
  /**
   * Whether the last turn is still in flight (status !== "idle"), including
   * question/permission pauses. Distinct from `isStreaming` (tokens arriving):
   * summary mode keeps the turn live off this signal, not `isStreaming`.
   * Defaults to `isStreaming` when omitted.
   */
  turnActive?: boolean;
  showStreamingIndicator?: boolean;
  lifecycle?: TurnLifecycle;
  workingLabel?: string;
  /** Base path to strip from file paths in diffs */
  basePath?: string;
  /** Callback ref for the scrollable container (auto-scroll listeners attach here). */
  scrollContainerRef?: ScrollRef;
  /** Imperative handle to Virtuoso (used to scroll to the true last item). */
  virtuosoRef?: Ref<VirtuosoHandle>;
  /**
   * Virtuoso `followOutput` callback. Returns `'auto'` while auto-scroll is
   * engaged so the view stays pinned to the bottom across async item
   * measurement (markdown highlighting, BashBlock query loads, etc.).
   */
  followOutput?: FollowOutput;
  /** Virtuoso's measurement-aware bottom-state callback. */
  onAtBottomStateChange?: (atBottom: boolean) => void;
  /**
   * Fires whenever Virtuoso recomputes the total list height (i.e. after an
   * item remeasures). Used by the auto-scroll hook to keep the view pinned
   * to the bottom while measurements settle on cold-open.
   */
  onTotalListHeightChanged?: (height: number) => void;
  /** Called by Virtuoso when the first rendered item is reached. */
  onStartReached?: () => void;
  /** When true, a spinner is shown above the first item (older history loading). */
  isLoadingOlder?: boolean;
  /** Number of rendered Virtuoso rows prepended by older-history pagination. */
  historyPrependDisplayOffset?: number;
  verbosityMode?: AgentVerbosityMode;
  /**
   * "Summary mode": collapse each turn's tool calls into a single recap block
   * (per-tool counts) followed by the turn's text. Independent of
   * `verbosityMode`. See `collapseTurnsToSummary`.
   */
  summaryMode?: boolean;
  /**
   * Enables the ⌘F find-in-conversation bar. Passed down as the agent-tab
   * focus gate so search only binds/opens for the visible feature workspace.
   */
  searchEnabled?: boolean;
}

const StreamingCursor = memo(function StreamingCursor({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-primary">
      <span className="animate-pulse">█</span>
      <span className="font-medium tabular-nums">{label}</span>
    </div>
  );
});

const StreamFooter = memo(function StreamFooter({
  context,
}: {
  context?: AgentStreamVirtuosoContext;
}) {
  if (!context?.showStreamingIndicator) return null;
  return <TurnProgressCursor lifecycle={context.lifecycle} label={context.workingLabel} />;
});

const VIRTUOSO_COMPONENTS = {
  Footer: StreamFooter,
} satisfies Components<DisplayItem, AgentStreamVirtuosoContext>;

const LoadingOlderOverlay = memo(function LoadingOlderOverlay() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <div className="rounded-full border bg-background/80 p-1 shadow-sm backdrop-blur">
        <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    </div>
  );
});

function useAgentStreamRefs(
  virtuosoRef: Ref<VirtuosoHandle> | undefined,
  scrollContainerRef: ScrollRef | undefined,
) {
  const localVirtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const setVirtuoso = useCallback(
    (handle: VirtuosoHandle | null): void => {
      localVirtuosoRef.current = handle;
      if (typeof virtuosoRef === "function") virtuosoRef(handle);
      else if (virtuosoRef)
        (virtuosoRef as MutableRefObject<VirtuosoHandle | null>).current = handle;
    },
    [virtuosoRef],
  );
  const onScroller = useCallback(
    (element: HTMLElement | Window | null): void => {
      const scroller = element instanceof HTMLElement ? element : null;
      scrollerElRef.current = scroller;
      scrollContainerRef?.(scroller);
    },
    [scrollContainerRef],
  );
  return useMemo(
    () => ({ localVirtuosoRef, scrollerElRef, setVirtuoso, onScroller }),
    [onScroller, setVirtuoso],
  );
}

function useAgentStreamItemRenderer(
  basePath: string | undefined,
  toolResultMap: Map<string, AgentBlockData>,
  verbosityMode: AgentVerbosityMode,
) {
  return useCallback(
    (_index: number, item: DisplayItem, context: AgentStreamVirtuosoContext) => {
      if (item.kind === "flow") {
        return <CompactFlowRow blocks={item.blocks} basePath={basePath} />;
      }
      return (
        <AgentStreamItem
          block={item.block}
          isStreaming={context.streamingBlockId === item.block.id}
          basePath={basePath}
          toolResultMap={toolResultMap}
          verbosityMode={verbosityMode}
        />
      );
    },
    [basePath, toolResultMap, verbosityMode],
  );
}

interface AgentVirtuosoProps {
  items: DisplayItem[];
  firstItemIndex: number;
  context: AgentStreamVirtuosoContext;
  followOutput?: FollowOutput;
  onAtBottomStateChange?: AgentStreamProps["onAtBottomStateChange"];
  onTotalListHeightChanged?: AgentStreamProps["onTotalListHeightChanged"];
  onStartReached?: AgentStreamProps["onStartReached"];
  setVirtuoso: (handle: VirtuosoHandle | null) => void;
  onScroller: (element: HTMLElement | Window | null) => void;
  computeItemKey: (index: number) => string;
  onRangeChanged: (range: ListRange) => void;
  renderItem: (index: number, item: DisplayItem, context: AgentStreamVirtuosoContext) => ReactNode;
}

function AgentVirtuoso({
  items,
  firstItemIndex,
  context,
  followOutput,
  onAtBottomStateChange,
  onTotalListHeightChanged,
  onStartReached,
  setVirtuoso,
  onScroller,
  computeItemKey,
  onRangeChanged,
  renderItem,
}: AgentVirtuosoProps) {
  return (
    <Virtuoso
      data-testid="agent-stream-scroller"
      className="h-full overflow-x-hidden"
      style={{ height: "100%" }}
      ref={setVirtuoso}
      scrollerRef={onScroller}
      data={items}
      firstItemIndex={firstItemIndex}
      computeItemKey={computeItemKey}
      initialTopMostItemIndex={{ index: "LAST", align: "end" }}
      defaultItemHeight={40}
      increaseViewportBy={{ top: 600, bottom: 400 }}
      minOverscanItemCount={{ top: 4, bottom: 3 }}
      overscan={{ main: 300, reverse: 300 }}
      components={VIRTUOSO_COMPONENTS}
      context={context}
      followOutput={followOutput}
      atBottomStateChange={onAtBottomStateChange}
      atBottomThreshold={16}
      totalListHeightChanged={onTotalListHeightChanged}
      startReached={onStartReached}
      rangeChanged={onRangeChanged}
      itemContent={renderItem}
    />
  );
}

export const AgentStream = memo(function AgentStream({
  blocks,
  rootBlocks: rootBlocksProp,
  toolResultMap: toolResultMapProp,
  isStreaming,
  turnActive,
  showStreamingIndicator = true,
  lifecycle,
  workingLabel = "Working",
  basePath,
  scrollContainerRef,
  virtuosoRef,
  followOutput,
  onAtBottomStateChange,
  onTotalListHeightChanged,
  onStartReached,
  isLoadingOlder = false,
  historyPrependDisplayOffset = 0,
  verbosityMode = "maximal",
  summaryMode = false,
  searchEnabled = false,
}: AgentStreamProps) {
  const rootBlocks = useRootBlocks(blocks, rootBlocksProp);
  const toolResultMap = useToolResultMap(blocks, toolResultMapProp);
  const { displayBlocks, displayItems } = useAgentDisplayItems(
    rootBlocks,
    summaryMode,
    turnActive,
    isStreaming,
    verbosityMode,
  );
  const firstItemIndex = FIRST_ITEM_INDEX_BASE - historyPrependDisplayOffset;

  // Only the last displayed block can receive stream chunks; pass its id
  // through Virtuoso context so older memoized rows remain stable.
  const lastBlockId = displayBlocks.at(-1)?.id;
  const virtuosoContext = useMemo(
    (): AgentStreamVirtuosoContext => ({
      showStreamingIndicator,
      streamingBlockId: isStreaming && lastBlockId ? lastBlockId : null,
      lifecycle,
      workingLabel,
    }),
    [isStreaming, lastBlockId, lifecycle, showStreamingIndicator, workingLabel],
  );
  const streamRefs = useAgentStreamRefs(virtuosoRef, scrollContainerRef);
  const onRangeChanged = useCallback(
    (range: ListRange): void => {
      if (range.startIndex <= firstItemIndex + HISTORY_PREFETCH_ROWS) onStartReached?.();
    },
    [firstItemIndex, onStartReached],
  );
  const computeItemKey = useCallback(
    (i: number): string => {
      const localIndex = i - firstItemIndex;
      return displayItems[localIndex]?.key ?? String(i);
    },
    [displayItems, firstItemIndex],
  );
  const renderItem = useAgentStreamItemRenderer(basePath, toolResultMap, verbosityMode);

  if (displayItems.length === 0) {
    return (
      <div className="p-3">
        {showStreamingIndicator && (
          <TurnProgressCursor lifecycle={lifecycle} label={workingLabel} />
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full" data-rich-copy="true">
      {isLoadingOlder && <LoadingOlderOverlay />}
      {searchEnabled && (
        <ConversationSearch
          enabled={searchEnabled}
          items={displayItems}
          virtuosoRef={streamRefs.localVirtuosoRef}
          scrollerRef={streamRefs.scrollerElRef}
        />
      )}
      <AgentVirtuoso
        items={displayItems}
        firstItemIndex={firstItemIndex}
        context={virtuosoContext}
        followOutput={followOutput}
        onAtBottomStateChange={onAtBottomStateChange}
        onTotalListHeightChanged={onTotalListHeightChanged}
        onStartReached={onStartReached}
        setVirtuoso={streamRefs.setVirtuoso}
        onScroller={streamRefs.onScroller}
        computeItemKey={computeItemKey}
        onRangeChanged={onRangeChanged}
        renderItem={renderItem}
      />
    </div>
  );
});

const TurnProgressCursor = memo(function TurnProgressCursor({
  lifecycle,
  label,
}: {
  lifecycle?: TurnLifecycle;
  label: string;
}) {
  if (!isTurnInProgress(lifecycle)) return null;
  return <StreamingCursor label={label} />;
});
