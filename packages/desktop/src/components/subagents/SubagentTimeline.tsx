import {
  memo,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Virtuoso, type ItemContent, type VirtuosoHandle } from "react-virtuoso";
import type { AgentBlockData } from "@/types/agent-block";
import { SubagentActionRow } from "@/components/SubagentActionRow";
import { isNestedSubagentBlock } from "@/components/subagent-actions";
import { useStickToBottom } from "@/hooks/useStickToBottom";

/** Stop nesting sub-agent cards past this depth (indent and recursion). */
export const MAX_SUBAGENT_DEPTH = 4;
/** Small timelines stay inline so expanding them does not create empty space. */
const MAX_INLINE_SUBAGENT_ACTIONS = 24;
const INITIAL_VIRTUALIZED_SUBAGENT_ACTIONS = 12;
const SCROLL_TO_END = Number.MAX_SAFE_INTEGER;

/** Renders a nested sub-agent inside a timeline (breaks the import cycle). */
export type NestedSubagentRenderer = (block: AgentBlockData, depth: number) => ReactElement;

export interface SubagentTimelineProps {
  actions: AgentBlockData[];
  basePath?: string;
  depth: number;
  description: string;
  isRunning: boolean;
  renderNested: NestedSubagentRenderer;
}

export const SubagentTimeline = memo(function SubagentTimeline(props: SubagentTimelineProps) {
  if (props.actions.length > MAX_INLINE_SUBAGENT_ACTIONS) {
    return <VirtualizedSubagentTimeline {...props} />;
  }
  return <InlineSubagentTimeline {...props} />;
});

function InlineSubagentTimeline({
  actions,
  basePath,
  depth,
  isRunning,
  renderNested,
}: SubagentTimelineProps): ReactElement {
  const lastId = actions.at(-1)?.id;
  const { scrollRef, contentRef } = useStickToBottom(isRunning);
  return (
    <div ref={scrollRef} className="max-h-[28vh] min-w-0 overflow-y-auto">
      <div ref={contentRef} className="flex flex-col gap-0">
        {actions.map((child) => (
          <SubagentTimelineRow
            key={child.id}
            block={child}
            basePath={basePath}
            depth={depth}
            isStreaming={isRunning && child.id === lastId}
            renderNested={renderNested}
          />
        ))}
      </div>
    </div>
  );
}

interface VirtualizedSubagentContext {
  basePath?: string;
  depth: number;
  isRunning: boolean;
  lastIndex: number;
  renderNested: NestedSubagentRenderer;
}

const virtualizedSubagentItemKey = (_index: number, child: AgentBlockData): string => child.id;

const renderVirtualizedSubagentAction: ItemContent<AgentBlockData, VirtualizedSubagentContext> = (
  index,
  child,
  context,
) => (
  <SubagentTimelineRow
    block={child}
    basePath={context.basePath}
    depth={context.depth}
    isStreaming={context.isRunning && index === context.lastIndex}
    renderNested={context.renderNested}
  />
);

function VirtualizedSubagentTimeline({
  actions,
  basePath,
  depth,
  description,
  isRunning,
  renderNested,
}: SubagentTimelineProps): ReactElement {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const followsTailRef = useRef(isRunning);
  const pendingEdgeRef = useRef<"start" | "end" | null>(null);
  const onAtBottomStateChange = useCallback((atBottom: boolean): void => {
    if (pendingEdgeRef.current === "start") {
      if (atBottom) return;
      pendingEdgeRef.current = null;
    } else if (pendingEdgeRef.current === "end") {
      if (!atBottom) return;
      pendingEdgeRef.current = null;
    }
    followsTailRef.current = atBottom;
  }, []);
  const onTotalListHeightChanged = useCallback((): void => {
    if (!followsTailRef.current) return;
    // Unlike item-index scrolling, a direct offset does not retry after later
    // measurements and override a wheel gesture that has since detached follow.
    virtuosoRef.current?.scrollTo({ top: SCROLL_TO_END, behavior: "auto" });
  }, []);
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>): void => {
    if (
      event.target !== event.currentTarget ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      (event.key !== "Home" && event.key !== "End")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const atStart = event.key === "Home";
    if (atStart) {
      if (followsTailRef.current) pendingEdgeRef.current = "start";
      followsTailRef.current = false;
    } else {
      pendingEdgeRef.current = "end";
      followsTailRef.current = true;
    }
    virtuosoRef.current?.scrollTo({ top: atStart ? 0 : SCROLL_TO_END, behavior: "auto" });
  }, []);
  const onWheel = useCallback((event: ReactWheelEvent<HTMLElement>): void => {
    if (event.deltaY >= 0 || !followsTailRef.current) return;
    pendingEdgeRef.current = "start";
    followsTailRef.current = false;
  }, []);
  const context = useMemo<VirtualizedSubagentContext>(
    () => ({ basePath, depth, isRunning, lastIndex: actions.length - 1, renderNested }),
    [actions.length, basePath, depth, isRunning, renderNested],
  );

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={actions}
      context={context}
      computeItemKey={virtualizedSubagentItemKey}
      itemContent={renderVirtualizedSubagentAction}
      initialItemCount={INITIAL_VIRTUALIZED_SUBAGENT_ACTIONS}
      initialTopMostItemIndex={isRunning ? { index: actions.length - 1, align: "end" } : 0}
      defaultItemHeight={24}
      increaseViewportBy={48}
      atBottomStateChange={onAtBottomStateChange}
      totalListHeightChanged={onTotalListHeightChanged}
      onKeyDown={onKeyDown}
      onWheel={onWheel}
      className="min-w-0 overflow-x-hidden"
      style={{ height: "28vh" }}
      role="region"
      aria-label={`${description} actions`}
      tabIndex={0}
      data-testid="subagent-action-timeline"
    />
  );
}

const SubagentTimelineRow = memo(function SubagentTimelineRow({
  block,
  basePath,
  depth,
  isStreaming,
  renderNested,
}: {
  block: AgentBlockData;
  basePath?: string;
  depth: number;
  isStreaming: boolean;
  renderNested: NestedSubagentRenderer;
}): ReactElement {
  return (
    <div data-block-id={block.id} data-subagent-action-id={block.id}>
      {isNestedSubagentBlock(block) && depth < MAX_SUBAGENT_DEPTH ? (
        renderNested(block, depth + 1)
      ) : (
        <SubagentActionRow block={block} basePath={basePath} expanded isStreaming={isStreaming} />
      )}
    </div>
  );
});
