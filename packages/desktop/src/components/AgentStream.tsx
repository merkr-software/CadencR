import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
import {
  Virtuoso,
  type Components,
  type FollowOutput,
  type SizeFunction,
  type VirtuosoHandle,
} from "react-virtuoso";
import type { AgentBlockData } from "@/types/agent-block";
import { AgentStreamItem } from "./agent-session/AgentStreamItem";
import { STREAM_AT_BOTTOM_THRESHOLD_PX, STREAM_BOTTOM_GAP_PX } from "./agent-session/stream-fade";
import { CompactFlowRow } from "./agent-session/CompactFlowRow";
import { HistoryGapRow } from "./agent-session/HistoryGapRow";
import type { HistoryGapStatus } from "./agent-session/useHistoryGapFiller";
import { flowStreamingBlockId, liveDisplayItemKey } from "@/lib/agent-stream-display";
import { cursorSpaceAbove, STREAM_TOP_GAP_PX } from "@/lib/stream-rhythm";
import { AgentStreamTools } from "./agent-session/AgentStreamTools";
import type { MessageNavigatorControls } from "./agent-session/useMessageNavigator";
import type { DisplayItem, HistoryGap } from "@/types/agent-stream";
import { NO_HISTORY_GAPS } from "@/stores/ws-history-gaps";
import { useAgentDisplayItems, useRootBlocks, useToolResultMap } from "./useAgentStreamData";
import type { TurnLifecycle } from "@/stores/ws-turn-lifecycle";
import type { TurnClock } from "@/lib/turn-clock";
import { TurnProgressCursor } from "./agent-session/TurnProgressCursor";
import { useTailPreview } from "./agent-session/TranscriptTailPreview";
import type { AgentVerbosityMode } from "@/lib/agent-verbosity";

type ScrollRef = (el: HTMLElement | null) => void;
const FIRST_ITEM_INDEX_BASE = 1_000_000;
/**
 * Virtuoso's guess for a row it has not measured. It also sets how many rows
 * the list mounts when it opens (viewport and overscan divided by this): at
 * 40 px it mounted a whole 40-message page to keep the half dozen in view.
 * Rows run from a 26 px tool line to several screens of prose; 120 px is near
 * their median.
 */
const DEFAULT_ROW_HEIGHT_PX = 120;

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
  /** Live turn clock: the cursor ticks its elapsed time itself. */
  workingClock: TurnClock | null;
  /** Block holding the active search match: a compact run holding it unfolds. */
  searchBlockId: string | null;
  /** Key of the last row while the turn runs: a compact run there may still take steps. */
  liveItemKey: string | null;
  /** Padding above the working cursor, one gap under the last row. */
  cursorSpaceAbove: number;
  /** Which history gap row is loading or failed; null where gaps never fill. */
  gapStatus: HistoryGapStatus | null;
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
  /** When set, the cursor shows this turn's live "Working · model · 12s" label. */
  workingClock?: TurnClock | null;
  /** Base path to strip from file paths in diffs */
  basePath?: string;
  /** Callback ref for the scrollable container (auto-scroll listeners attach here). */
  scrollContainerRef?: ScrollRef;
  /** Imperative handle to Virtuoso (used to scroll to the true last item). */
  virtuosoRef?: Ref<VirtuosoHandle>;
  /** Virtuoso row measurement (the scroll hook's anchor guard hooks in here). */
  itemSize?: SizeFunction;
  /**
   * Virtuoso `followOutput`. On iOS a callback returning `'auto'` while
   * auto-scroll is engaged; elsewhere `false`, as the scroll hook pins the
   * real bottom itself (see `useAgentSessionScroll`).
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
  /** Number of rendered Virtuoso rows history pages added above the reader. */
  historyPrependDisplayOffset?: number;
  /** Saved history not loaded yet: each gap renders as a row between the rows around it. */
  historyGaps?: HistoryGap[];
  /** Fill state of those rows (`useHistoryGapFiller`). */
  historyGapStatus?: HistoryGapStatus | null;
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
  /** Scroll hooks for the prompt rail; null/absent hides it (Settings → Appearance → Agent transcript). */
  messageNavigator?: MessageNavigatorControls | null;
  /**
   * Paint the transcript's last rows in the commit that mounts the stream,
   * ahead of the list (see `TranscriptTailPreview`). For a full-page
   * conversation being opened; the rows are rendered a second time by the
   * list, which a grid of small cards mounting together should not pay.
   */
  openingPreview?: boolean;
}

// The spacer is unconditional and lives inside the list rather than as padding
// on the wrapper: the composer's fade band sits on the scroller's clip edge, so
// anything that comes to rest against that edge rests under the ramp. Keeping
// the gap here means the transcript scrolls *through* the fade while a settled
// last message stays clear of it.
const STREAM_BOTTOM_GAP_STYLE: CSSProperties = { height: STREAM_BOTTOM_GAP_PX };

const StreamFooter = memo(function StreamFooter({
  context,
}: {
  context?: AgentStreamVirtuosoContext;
}) {
  return (
    <>
      {context?.showStreamingIndicator && (
        <TurnProgressCursor
          lifecycle={context.lifecycle}
          label={context.workingLabel}
          clock={context.workingClock}
          spaceAbove={context.cursorSpaceAbove}
        />
      )}
      <div aria-hidden style={STREAM_BOTTOM_GAP_STYLE} />
    </>
  );
});

// Rows hang their gaps below them (`stream-rhythm.ts`): the first row's room
// above is the list's, so a history page loading above it moves nothing.
const STREAM_TOP_GAP_STYLE: CSSProperties = { height: STREAM_TOP_GAP_PX };
const StreamHeader = memo(function StreamHeader() {
  return <div aria-hidden style={STREAM_TOP_GAP_STYLE} />;
});

const VIRTUOSO_COMPONENTS = {
  Header: StreamHeader,
  Footer: StreamFooter,
} satisfies Components<DisplayItem, AgentStreamVirtuosoContext>;

/** No rows yet: only the working cursor, while a turn runs. */
function EmptyStream({ context }: { context: AgentStreamVirtuosoContext }) {
  return (
    <div className="p-3">
      {context.showStreamingIndicator && (
        <TurnProgressCursor
          lifecycle={context.lifecycle}
          label={context.workingLabel}
          clock={context.workingClock}
        />
      )}
    </div>
  );
}

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

/** Row keys, offset by `firstItemIndex`. */
function useComputeItemKey(displayItems: DisplayItem[], firstItemIndex: number) {
  return useCallback(
    (i: number): string => displayItems[i - firstItemIndex]?.key ?? String(i),
    [displayItems, firstItemIndex],
  );
}

function useVirtuosoContext({
  showStreamingIndicator,
  streamingBlockId,
  lifecycle,
  workingLabel,
  workingClock,
  searchBlockId,
  liveItemKey,
  cursorSpaceAbove,
  gapStatus,
}: AgentStreamVirtuosoContext): AgentStreamVirtuosoContext {
  return useMemo(
    () => ({
      showStreamingIndicator,
      streamingBlockId,
      lifecycle,
      workingLabel,
      workingClock,
      searchBlockId,
      liveItemKey,
      cursorSpaceAbove,
      gapStatus,
    }),
    [
      showStreamingIndicator,
      streamingBlockId,
      lifecycle,
      workingLabel,
      workingClock,
      searchBlockId,
      liveItemKey,
      cursorSpaceAbove,
      gapStatus,
    ],
  );
}

function useAgentStreamItemRenderer(
  basePath: string | undefined,
  toolResultMap: Map<string, AgentBlockData>,
  verbosityMode: AgentVerbosityMode,
) {
  return useCallback(
    (_index: number, item: DisplayItem, context: AgentStreamVirtuosoContext) => {
      if (item.kind === "gap") {
        return (
          <HistoryGapRow gap={item.gap} status={context.gapStatus} spaceBelow={item.spaceBelow} />
        );
      }
      if (item.kind === "flow") {
        const target = context.searchBlockId;
        const reveal = target && item.blocks.some((block) => block.id === target);
        return (
          <CompactFlowRow
            blocks={item.blocks}
            basePath={basePath}
            revealBlockId={reveal ? target : undefined}
            toolResultMap={toolResultMap}
            streamingBlockId={flowStreamingBlockId(item.blocks, context.streamingBlockId)}
            live={context.liveItemKey === item.key}
            spaceBelow={item.spaceBelow}
          />
        );
      }
      return (
        <AgentStreamItem
          block={item.block}
          isStreaming={context.streamingBlockId === item.block.id}
          basePath={basePath}
          toolResultMap={toolResultMap}
          verbosityMode={verbosityMode}
          spaceBelow={item.spaceBelow}
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
  itemSize?: SizeFunction;
  followOutput?: FollowOutput;
  onAtBottomStateChange?: AgentStreamProps["onAtBottomStateChange"];
  onTotalListHeightChanged?: AgentStreamProps["onTotalListHeightChanged"];
  setVirtuoso: (handle: VirtuosoHandle | null) => void;
  onScroller: (element: HTMLElement | Window | null) => void;
  computeItemKey: (index: number) => string;
  renderItem: (index: number, item: DisplayItem, context: AgentStreamVirtuosoContext) => ReactNode;
  /** Unpainted while the tail preview is on screen (`useTailPreview`). */
  style: CSSProperties;
}

function AgentVirtuoso({
  items,
  firstItemIndex,
  context,
  itemSize,
  followOutput,
  onAtBottomStateChange,
  onTotalListHeightChanged,
  setVirtuoso,
  onScroller,
  computeItemKey,
  renderItem,
  style,
}: AgentVirtuosoProps) {
  return (
    <Virtuoso
      data-testid="agent-stream-scroller"
      className="h-full overflow-x-hidden"
      style={style}
      ref={setVirtuoso}
      scrollerRef={onScroller}
      data={items}
      firstItemIndex={firstItemIndex}
      computeItemKey={computeItemKey}
      initialTopMostItemIndex={{ index: "LAST", align: "end" }}
      defaultItemHeight={DEFAULT_ROW_HEIGHT_PX}
      increaseViewportBy={{ top: 600, bottom: 400 }}
      minOverscanItemCount={{ top: 4, bottom: 3 }}
      overscan={{ main: 300, reverse: 300 }}
      itemSize={itemSize}
      components={VIRTUOSO_COMPONENTS}
      context={context}
      followOutput={followOutput}
      atBottomStateChange={onAtBottomStateChange}
      atBottomThreshold={STREAM_AT_BOTTOM_THRESHOLD_PX}
      totalListHeightChanged={onTotalListHeightChanged}
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
  workingClock = null,
  basePath,
  scrollContainerRef,
  virtuosoRef,
  itemSize,
  followOutput,
  onAtBottomStateChange,
  onTotalListHeightChanged,
  historyPrependDisplayOffset = 0,
  historyGaps = NO_HISTORY_GAPS,
  historyGapStatus = null,
  verbosityMode = "maximal",
  summaryMode = false,
  searchEnabled = false,
  messageNavigator = null,
  openingPreview = false,
}: AgentStreamProps) {
  const rootBlocks = useRootBlocks(blocks, rootBlocksProp);
  const toolResultMap = useToolResultMap(blocks, toolResultMapProp);
  const { displayBlocks, displayItems } = useAgentDisplayItems(
    rootBlocks,
    summaryMode,
    turnActive,
    isStreaming,
    verbosityMode,
    historyGaps,
  );
  const firstItemIndex = FIRST_ITEM_INDEX_BASE - historyPrependDisplayOffset;

  const [searchBlockId, setSearchBlockId] = useState<string | null>(null);
  const virtuosoContext = useVirtuosoContext({
    showStreamingIndicator,
    // Only the last displayed block can receive stream chunks; pass its id
    // through Virtuoso context so older memoized rows remain stable.
    streamingBlockId: isStreaming ? (displayBlocks.at(-1)?.id ?? null) : null,
    lifecycle,
    workingLabel,
    workingClock,
    searchBlockId,
    liveItemKey: liveDisplayItemKey(displayItems, turnActive ?? !!isStreaming),
    cursorSpaceAbove: cursorSpaceAbove(displayItems.at(-1)),
    gapStatus: historyGapStatus,
  });
  const streamRefs = useAgentStreamRefs(virtuosoRef, scrollContainerRef);
  const computeItemKey = useComputeItemKey(displayItems, firstItemIndex);
  const renderItem = useAgentStreamItemRenderer(basePath, toolResultMap, verbosityMode);
  const tail = useTailPreview({
    enabled: openingPreview,
    scrollerRef: streamRefs.scrollerElRef,
    items: displayItems,
    renderItem,
    context: virtuosoContext,
    Footer: StreamFooter,
  });

  if (displayItems.length === 0) return <EmptyStream context={virtuosoContext} />;

  return (
    // With the navigator on, the stream gives up 8px so its rail gets a lane
    // of its own: the wrapper's right padding alone is partly taken by the
    // split-pane resize handle's hit area.
    <div
      className={messageNavigator ? "relative mr-2 h-full" : "relative h-full"}
      data-rich-copy="true"
    >
      <AgentStreamTools
        items={displayItems}
        toolResultMap={toolResultMap}
        virtuosoRef={streamRefs.localVirtuosoRef}
        scrollerRef={streamRefs.scrollerElRef}
        shortcutsEnabled={searchEnabled}
        messageNavigator={messageNavigator}
        onSearchBlockChange={setSearchBlockId}
      />
      <AgentVirtuoso
        items={displayItems}
        firstItemIndex={firstItemIndex}
        context={virtuosoContext}
        itemSize={itemSize}
        followOutput={followOutput}
        onAtBottomStateChange={onAtBottomStateChange}
        onTotalListHeightChanged={onTotalListHeightChanged}
        setVirtuoso={streamRefs.setVirtuoso}
        onScroller={streamRefs.onScroller}
        computeItemKey={computeItemKey}
        renderItem={renderItem}
        style={tail.listStyle}
      />
      {tail.preview}
    </div>
  );
});
