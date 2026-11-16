import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { UnifiedAgentEntry } from "@/api/generated";
import { UnifiedAgentCard } from "@/components/UnifiedAgentCard";
import { useFocusedUnifiedAgent } from "@/components/UnifiedAgentsGridFocus";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { popResize, pushResize } from "@/lib/resize-coordinator";
import {
  clampRowHeight,
  getAgentPanelId,
  getRowLayoutKey,
  getStoredRowWidthLayout,
  loadRowHeights,
  loadRowWidths,
  saveRowHeights,
  saveRowWidths,
  type PanelLayout,
  type RowHeightMap,
  type RowLayoutKey,
  type RowWidthLayouts,
} from "./unified-agents-grid-persistence";

export {
  buildUnifiedAgentPanelId,
  buildUnifiedAgentsRowLayoutKey,
  parseUnifiedAgentsRowHeights,
  parseUnifiedAgentsRowWidths,
} from "./unified-agents-grid-persistence";

// Override react-resizable-panels' inline `overflow: hidden`/`auto` so the
// active card's drop shadow isn't clipped at the panel bounds.
const SHADOW_FRIENDLY_OVERFLOW: CSSProperties = { overflow: "visible" };
const ROW_FILLER_PANEL_ID = "unified-agents-row-filler";

interface UnifiedAgentsGridProps {
  agents: UnifiedAgentEntry[];
  /** Cards per row, already fitted to the grid width. */
  columns: number;
  /** Height of a row the user hasn't resized. */
  defaultRowHeight: number;
  activeIndex: number;
  focusVersion: number;
  onActivate: (sessionId: number) => void;
  onExcludeAgent: (title: string) => void;
}

export const UnifiedAgentsGrid = memo(function UnifiedAgentsGrid({
  agents,
  columns,
  defaultRowHeight,
  activeIndex,
  focusVersion,
  onActivate,
  onExcludeAgent,
}: UnifiedAgentsGridProps): ReactElement {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const { rowHeights, setRowHeight } = useRowHeights();
  const { rowWidths, setRowWidthLayout } = useRowWidths();
  const rows = useMemo(() => chunkAgents(agents, columns), [agents, columns]);
  const activeRow = Math.floor(activeIndex / columns);
  useFocusedUnifiedAgent({ activeIndex, activeRow, focusVersion, virtuosoRef });

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={rows}
      className="min-h-0 flex-1"
      overscan={900}
      itemContent={(rowIndex, rowAgents) => {
        const rowLayoutKey = getRowLayoutKey(rowIndex, columns);
        return (
          <UnifiedAgentsRow
            rowAgents={rowAgents}
            rowLayoutKey={rowLayoutKey}
            rowStartIndex={rowIndex * columns}
            rowIndex={rowIndex}
            columns={columns}
            rowHeight={rowHeights[rowLayoutKey] ?? defaultRowHeight}
            rowWidthLayout={getStoredRowWidthLayout(rowAgents, rowWidths[rowLayoutKey])}
            activeIndex={activeIndex}
            onRowHeightChange={setRowHeight}
            onRowWidthLayoutChange={setRowWidthLayout}
            onActivate={onActivate}
            onExcludeAgent={onExcludeAgent}
          />
        );
      }}
    />
  );
});

function UnifiedAgentsRow({
  rowAgents,
  rowLayoutKey,
  rowStartIndex,
  rowIndex,
  columns,
  rowHeight,
  rowWidthLayout,
  activeIndex,
  onRowHeightChange,
  onRowWidthLayoutChange,
  onActivate,
  onExcludeAgent,
}: {
  rowAgents: UnifiedAgentEntry[];
  rowLayoutKey: RowLayoutKey;
  rowStartIndex: number;
  rowIndex: number;
  columns: number;
  rowHeight: number;
  rowWidthLayout: PanelLayout | undefined;
  activeIndex: number;
  onRowHeightChange: (rowLayoutKey: RowLayoutKey, height: number, persist: boolean) => void;
  onRowWidthLayoutChange: (rowLayoutKey: RowLayoutKey, layout: PanelLayout) => void;
  onActivate: (sessionId: number) => void;
  onExcludeAgent: (title: string) => void;
}): ReactElement {
  const onLayoutChanged = useCallback(
    (layout: PanelLayout): void => onRowWidthLayoutChange(rowLayoutKey, layout),
    [onRowWidthLayoutChange, rowLayoutKey],
  );

  // A short last row keeps one column's width per card rather than
  // stretching an orphan across the whole grid: a locked filler panel takes
  // the missing columns. Same panel tree either way, so a row filling up (or
  // losing a card) never remounts the cards it keeps.
  const missingColumns = columns - rowAgents.length;
  const isPartialRow = missingColumns > 0;
  const columnSize = 100 / columns;
  return (
    <div className={cn("px-1.5", rowIndex === 0 && "pt-2")}>
      <div style={{ height: rowHeight }} className="min-h-[420px]">
        <ResizablePanelGroup
          orientation="horizontal"
          className="h-full"
          disabled={isPartialRow}
          onLayoutChanged={isPartialRow ? undefined : onLayoutChanged}
          style={SHADOW_FRIENDLY_OVERFLOW}
        >
          {rowAgents.map((entry, offset) => {
            const index = rowStartIndex + offset;
            const panelId = getAgentPanelId(entry);
            return (
              <RowPanel
                key={panelId}
                entry={entry}
                panelId={panelId}
                defaultSize={isPartialRow ? columnSize : rowWidthLayout?.[panelId]}
                index={index}
                isActive={index === activeIndex}
                hasHandle={!isPartialRow && offset < rowAgents.length - 1}
                onActivate={onActivate}
                onExcludeAgent={onExcludeAgent}
              />
            );
          })}
          {isPartialRow && (
            <ResizablePanel id={ROW_FILLER_PANEL_ID} defaultSize={missingColumns * columnSize} />
          )}
        </ResizablePanelGroup>
      </div>
      <RowResizeHandle
        rowLayoutKey={rowLayoutKey}
        rowIndex={rowIndex}
        rowHeight={rowHeight}
        onRowHeightChange={onRowHeightChange}
      />
    </div>
  );
}

function RowResizeHandle({
  rowLayoutKey,
  rowIndex,
  rowHeight,
  onRowHeightChange,
}: {
  rowLayoutKey: RowLayoutKey;
  rowIndex: number;
  rowHeight: number;
  onRowHeightChange: (rowLayoutKey: RowLayoutKey, height: number, persist: boolean) => void;
}): ReactElement {
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault();
      dragRef.current = { startY: event.clientY, startHeight: rowHeight };
      pushResize();
      const onMove = (moveEvent: PointerEvent): void => {
        const drag = dragRef.current;
        if (!drag) return;
        const next = clampRowHeight(drag.startHeight + moveEvent.clientY - drag.startY);
        onRowHeightChange(rowLayoutKey, next, false);
      };
      const onEnd = (endEvent: PointerEvent): void => {
        const drag = dragRef.current;
        dragRef.current = null;
        cleanupRef.current?.();
        cleanupRef.current = null;
        if (!drag) return;
        const next = clampRowHeight(drag.startHeight + endEvent.clientY - drag.startY);
        onRowHeightChange(rowLayoutKey, next, true);
      };
      cleanupRef.current = () => {
        popResize();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
    },
    [onRowHeightChange, rowHeight, rowLayoutKey],
  );
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize agent row ${rowIndex + 1}`}
      className={cn(
        "group relative mt-1 flex h-3 cursor-row-resize items-center justify-center",
        "before:absolute before:left-0 before:right-0 before:top-1/2 before:h-px before:-translate-y-1/2 before:opacity-0 before:transition-opacity",
        "before:[background:repeating-linear-gradient(to_right,var(--border)_0_4px,transparent_4px_8px)]",
        "before:[mask-image:linear-gradient(to_right,transparent,black_20%,black_80%,transparent)]",
        "hover:before:opacity-100",
      )}
      onPointerDown={onPointerDown}
    >
      <div className="pointer-events-none z-10 h-1 w-8 rounded-full bg-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  );
}

function RowPanel({
  entry,
  panelId,
  defaultSize,
  index,
  isActive,
  hasHandle,
  onActivate,
  onExcludeAgent,
}: {
  entry: UnifiedAgentEntry;
  panelId: string;
  defaultSize: number | undefined;
  index: number;
  isActive: boolean;
  hasHandle: boolean;
  onActivate: (sessionId: number) => void;
  onExcludeAgent: (title: string) => void;
}): ReactElement {
  return (
    <>
      <ResizablePanel
        id={panelId}
        defaultSize={defaultSize}
        minSize={12}
        className="min-w-0 px-1.5"
        style={SHADOW_FRIENDLY_OVERFLOW}
      >
        <UnifiedAgentCard
          entry={entry}
          index={index}
          isActive={isActive}
          onActivate={onActivate}
          onExcludeAgent={onExcludeAgent}
        />
      </ResizablePanel>
      {hasHandle && <ResizableHandle className="bg-transparent" />}
    </>
  );
}

function chunkAgents(entries: UnifiedAgentEntry[], columns: number): UnifiedAgentEntry[][] {
  const rows: UnifiedAgentEntry[][] = [];
  for (let index = 0; index < entries.length; index += columns) {
    rows.push(entries.slice(index, index + columns));
  }
  return rows;
}

function useRowHeights(): {
  rowHeights: RowHeightMap;
  setRowHeight: (rowLayoutKey: RowLayoutKey, height: number, persist: boolean) => void;
} {
  const [rowHeights, setRowHeights] = useState<RowHeightMap>(loadRowHeights);
  const setRowHeight = useCallback(
    (rowLayoutKey: RowLayoutKey, height: number, persist: boolean): void => {
      const nextHeight = clampRowHeight(height);
      setRowHeights((current) => {
        const next = { ...current, [rowLayoutKey]: nextHeight };
        if (persist) saveRowHeights(next);
        return next;
      });
    },
    [],
  );
  return { rowHeights, setRowHeight };
}

function useRowWidths(): {
  rowWidths: RowWidthLayouts;
  setRowWidthLayout: (rowLayoutKey: RowLayoutKey, layout: PanelLayout) => void;
} {
  const [rowWidths, setRowWidths] = useState<RowWidthLayouts>(loadRowWidths);
  const setRowWidthLayout = useCallback((rowLayoutKey: RowLayoutKey, layout: PanelLayout): void => {
    setRowWidths((current) => {
      const next = { ...current, [rowLayoutKey]: layout };
      saveRowWidths(next);
      return next;
    });
  }, []);
  return { rowWidths, setRowWidthLayout };
}
