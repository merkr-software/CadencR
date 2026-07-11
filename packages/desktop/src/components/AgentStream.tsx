import { memo, useCallback, useMemo, useRef, type MutableRefObject, type Ref } from "react";
import { Loader2Icon } from "lucide-react";
import {
  Virtuoso,
  type Components,
  type FollowOutput,
  type ListRange,
  type VirtuosoHandle,
} from "react-virtuoso";
import { type AgentBlockData, buildToolResultMap } from "./AgentBlock";
import { AgentStreamItem } from "./agent-session/AgentStreamItem";
import { CompactFlowRow } from "./agent-session/CompactFlowRow";
import { ConversationSearch } from "./agent-session/ConversationSearch";
import { buildDisplayItems, filterRenderableBlocks, type DisplayItem } from "./agentStreamDisplay";
import { collapseTurnsToSummary } from "./agentStreamSummary";
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

function useRootBlocks(
  blocks: AgentBlockData[],
  rootBlocksProp: AgentBlockData[] | undefined,
): AgentBlockData[] {
  return useMemo(
    () => rootBlocksProp ?? blocks.filter((block) => !block.parentToolUseId),
    [rootBlocksProp, blocks],
  );
}

function useToolResultMap(
  blocks: AgentBlockData[],
  toolResultMapProp: Map<string, AgentBlockData> | undefined,
): Map<string, AgentBlockData> {
  const fallbackToolResultCount = useMemo(
    () =>
      toolResultMapProp ? 0 : blocks.reduce((n, b) => n + (b.type === "tool_result" ? 1 : 0), 0),
    [blocks, toolResultMapProp],
  );
  const fallbackToolResultMap = useMemo(
    () => (toolResultMapProp ? new Map<string, AgentBlockData>() : buildToolResultMap(blocks)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: rebuild only on tool_result count change for the fallback path
    [fallbackToolResultCount, toolResultMapProp],
  );
  return toolResultMapProp ?? fallbackToolResultMap;
}

const LoadingOlderOverlay = memo(function LoadingOlderOverlay() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <div className="rounded-full border bg-background/80 p-1 shadow-sm backdrop-blur">
        <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    </div>
  );
});

export const AgentStream = memo(function AgentStream({
  blocks,
  rootBlocks: rootBlocksProp,
  toolResultMap: toolResultMapProp,
  isStreaming,
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
  const displayBlocks = useMemo(() => {
    const filtered = filterRenderableBlocks(rootBlocks);
    if (!summaryMode) return filtered;
    // The in-flight turn streams live; recaps appear only once a turn ends. Each
    // recap reveals its turn detail inline (local to the block), so no expand
    // state is threaded here.
    return collapseTurnsToSummary(filtered, { activeStreaming: !!isStreaming });
  }, [rootBlocks, summaryMode, isStreaming]);
  const toolResultMap = useToolResultMap(blocks, toolResultMapProp);
  const isCompact = verbosityMode === "compact";
  const displayItems = useMemo(
    () => buildDisplayItems(displayBlocks, { compact: isCompact }),
    [displayBlocks, isCompact],
  );
  const firstItemIndex = FIRST_ITEM_INDEX_BASE - historyPrependDisplayOffset;

  // The streaming cursor is, by construction, the last displayed block —
  // there is no separate "active block" pointer in the store. Threading just
  // its id (not the whole `isStreaming` boolean) keeps the per-item
  // `isStreaming={ctx.streamingBlockId === block.id}` check from flipping for
  // any block other than the one actually receiving chunks.
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
  // Local handles so the search overlay can drive scroll-to-match and walk the
  // scroller for highlighting, while still forwarding both refs to the owner.
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
    (el: HTMLElement | Window | null): void => {
      const element = el instanceof HTMLElement ? el : null;
      scrollerElRef.current = element;
      scrollContainerRef?.(element);
    },
    [scrollContainerRef],
  );
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
  // `renderItem` deliberately does NOT depend on `isStreaming` /
  // `streamingBlockId`. Those reach the item via Virtuoso `context` so
  // advancing the streaming cursor only re-renders the (up to) two blocks
  // whose per-block `isStreaming` flag actually flipped, not the entire list.
  const renderItem = useCallback(
    (_i: number, item: DisplayItem, ctx: AgentStreamVirtuosoContext) => {
      if (item.kind === "flow") {
        return <CompactFlowRow blocks={item.blocks} basePath={basePath} />;
      }
      return (
        <AgentStreamItem
          block={item.block}
          isStreaming={ctx.streamingBlockId === item.block.id}
          basePath={basePath}
          toolResultMap={toolResultMap}
          verbosityMode={verbosityMode}
        />
      );
    },
    [basePath, toolResultMap, verbosityMode],
  );

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
    <div className="relative h-full">
      {isLoadingOlder && <LoadingOlderOverlay />}
      {searchEnabled && (
        <ConversationSearch
          enabled={searchEnabled}
          items={displayItems}
          virtuosoRef={localVirtuosoRef}
          scrollerRef={scrollerElRef}
        />
      )}
      <Virtuoso
        data-testid="agent-stream-scroller"
        className="h-full overflow-x-hidden"
        style={{ height: "100%" }}
        ref={setVirtuoso}
        scrollerRef={onScroller}
        data={displayItems}
        firstItemIndex={firstItemIndex}
        computeItemKey={computeItemKey}
        initialTopMostItemIndex={{ index: "LAST", align: "end" }}
        defaultItemHeight={40}
        increaseViewportBy={{ top: 1600, bottom: 800 }}
        minOverscanItemCount={{ top: 12, bottom: 8 }}
        overscan={{ main: 800, reverse: 800 }}
        components={VIRTUOSO_COMPONENTS}
        context={virtuosoContext}
        followOutput={followOutput}
        atBottomStateChange={onAtBottomStateChange}
        atBottomThreshold={16}
        totalListHeightChanged={onTotalListHeightChanged}
        startReached={onStartReached}
        rangeChanged={onRangeChanged}
        itemContent={renderItem}
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
