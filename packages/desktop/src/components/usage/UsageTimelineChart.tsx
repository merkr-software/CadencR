import { memo, useId, useMemo, useState } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { axisTickIndexes, nextFocusIndex } from "./usage-axis";
import {
  allocateCells,
  CELL_DENSITY,
  CELL_GAP_PX,
  cellScopeStyle,
  columnCenterCss,
  columnLeftCss,
  DATE_BAND_CSS,
  gridWidthCss,
  type UsageDensity,
} from "./usage-cell-grid";
import { formatDayLabel, formatExactNumber, seriesColor } from "./usage-chart-palette";
import { UsageDayCard } from "./UsageDayCard";
import type { UsageChartData, UsageDay, UsageScale } from "./usage-stats-model";

interface UsageTimelineChartProps {
  /** Must hold some usage: callers show their own empty state. */
  data: UsageChartData;
  /** Names a series in the day card. */
  labelOf: (seriesKey: string) => string;
  density: UsageDensity;
  scale: UsageScale;
  /** Names the measure the cells encode, for screen readers. */
  metricLabel: string;
}

const GAP_STYLE = { gap: CELL_GAP_PX };

function preventDefault(event: Event): void {
  event.preventDefault();
}

function columnOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-day-column]") : null;
}

/**
 * The column under the pointer or focus, which anchors the day card, and the
 * roving tab stop: one stop for the whole chart, arrow keys within it, as a
 * 90-day timeline would otherwise put 90 stops before the next control.
 * The handlers are delegated, so they go on the grid, not on every column.
 */
function useColumnFocus(dayCount: number) {
  const [active, setActive] = useState<number | null>(null);
  const [tabStop, setTabStop] = useState(0);

  const activate = (target: EventTarget | null): number | null => {
    const column = columnOf(target);
    if (!column) return null;
    const index = Number(column.dataset.index);
    setActive(index);
    return index;
  };

  const handlers = {
    onPointerOver: (event: React.PointerEvent<HTMLDivElement>) => activate(event.target),
    onPointerLeave: () => setActive(null),
    onFocus: (event: React.FocusEvent<HTMLDivElement>) => {
      const index = activate(event.target);
      if (index !== null) setTabStop(index);
    },
    onBlur: (event: React.FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setActive(null);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      const current = columnOf(event.target);
      if (!current) return;
      const next = nextFocusIndex(event.key, Number(current.dataset.index), dayCount);
      if (next === null) return;
      event.preventDefault();
      // Focus moves for real, so the reader hears the day it landed on;
      // `onFocus` then moves the tab stop and the card.
      event.currentTarget.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
    },
  };

  return {
    active,
    clear: () => setActive(null),
    // Clamped: a shorter range can drop the column the stop was on.
    tabStop: Math.min(tabStop, dayCount - 1),
    handlers,
  };
}

/**
 * One column of square cells per day, centred in its container. Each series
 * takes a run of cells, the largest at the base, and the empty cells are a faint
 * track. Hovering or focusing a column fades the others and opens that day's
 * card, a single popover shared by every column.
 *
 * Cell size comes from CSS, so the grid tracks the pane width without any
 * layout measurement.
 */
function UsageTimelineChartImpl({
  data,
  labelOf,
  density,
  scale,
  metricLabel,
}: UsageTimelineChartProps): React.JSX.Element {
  const { rows, dates, rounded } = CELL_DENSITY[density];
  const dayCount = data.days.length;
  const { active, clear, tabStop, handlers } = useColumnFocus(dayCount);
  const cardId = useId();
  const activeDay = active === null ? undefined : data.days[active];

  const stacks = useMemo(
    () => data.days.map((day) => stackCells(day, scale === "share" ? day.total : data.max, rows)),
    [data, rows, scale],
  );
  const scopeStyle = useMemo(
    () => ({ ...cellScopeStyle(dayCount), width: gridWidthCss(dayCount) }),
    [dayCount],
  );

  return (
    <Popover
      open={activeDay !== undefined}
      onOpenChange={(open) => {
        if (!open) clear();
      }}
      modal={false}
    >
      <div className="@container w-full">
        <div className="relative mx-auto" style={scopeStyle}>
          <div
            role="group"
            aria-label={`Daily ${metricLabel}. Use the left and right arrow keys to read each day.`}
            data-active={active === null ? undefined : ""}
            // Rounding clips the grid itself: the corner cells take the curve.
            className={cn("group/plot flex", rounded && "overflow-hidden rounded-lg")}
            style={GAP_STYLE}
            {...handlers}
          >
            {data.days.map((day, index) => (
              <DayColumn
                key={day.day}
                index={index}
                cells={stacks[index]!}
                label={`${formatDayLabel(day.day)}: ${formatExactNumber(day.total)} ${metricLabel}`}
                isTabStop={index === tabStop}
                isActive={active === index}
                cardId={cardId}
              />
            ))}
          </div>
          {dates ? <DateLabels days={data.days} /> : null}
          {active === null ? null : (
            // Placed on the column's pitch rather than wrapping it, so one
            // anchor serves every column. Keyed so Radix measures it anew.
            <PopoverAnchor
              key={active}
              aria-hidden
              className="pointer-events-none absolute top-0"
              style={{ left: columnLeftCss(active), width: "var(--cell)" }}
            />
          )}
        </div>
      </div>
      <PopoverContent
        id={cardId}
        role="tooltip"
        side="top"
        sideOffset={6}
        collisionPadding={8}
        className="pointer-events-none w-max p-2"
        // The card is read, never entered: focus stays on the column, and moving
        // focus or the pointer to another column must not dismiss it.
        onOpenAutoFocus={preventDefault}
        onInteractOutside={preventDefault}
      >
        {activeDay ? <UsageDayCard day={activeDay} labelOf={labelOf} scale={scale} /> : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Date labels under the grid, on the pitch of their columns. A label per column
 * would clip "Jun 26" down to "J…", so only a few columns carry one.
 */
function DateLabels({ days }: { days: UsageDay[] }): React.JSX.Element {
  const ticks = useMemo(() => axisTickIndexes(days.length), [days.length]);
  return (
    <div className="relative" style={{ height: DATE_BAND_CSS }}>
      {days.map((day, index) =>
        ticks.has(index) ? (
          <span
            key={day.day}
            className="absolute top-1.5 -translate-x-1/2 whitespace-nowrap text-[10px] leading-none text-muted-foreground"
            style={{ left: columnCenterCss(index) }}
          >
            {formatDayLabel(day.day)}
          </span>
        ) : null,
      )}
    </div>
  );
}

interface DayColumnProps {
  index: number;
  /** Bottom-up: a series color per filled cell, `null` for the track. */
  cells: (string | null)[];
  label: string;
  isTabStop: boolean;
  isActive: boolean;
  cardId: string;
}

/** Memoized so moving the pointer re-renders only the two columns it crosses. */
const DayColumn = memo(function DayColumn({
  index,
  cells,
  label,
  isTabStop,
  isActive,
  cardId,
}: DayColumnProps): React.JSX.Element {
  return (
    <div
      data-day-column
      data-index={index}
      data-active={isActive ? "" : undefined}
      role="img"
      aria-label={label}
      aria-describedby={isActive ? cardId : undefined}
      tabIndex={isTabStop ? 0 : -1}
      className="flex shrink-0 cursor-default flex-col-reverse outline-none transition-opacity duration-150 group-data-[active]/plot:not-data-[active]:opacity-35 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      style={GAP_STYLE}
    >
      {cells.map((color, row) => (
        <span
          // Cells are positional: the row is the key, and a row keeps its place.
          key={row}
          aria-hidden
          className={cn("size-(--cell) shrink-0 rounded-[2px]", color === null && "bg-border/40")}
          style={color === null ? undefined : { backgroundColor: color }}
        />
      ))}
    </div>
  );
});

/**
 * One day's stack, bottom-up: the series' cells first (largest series lowest),
 * then empty track cells (`null`) up to the full height.
 */
function stackCells(day: UsageDay, max: number, rows: number): (string | null)[] {
  const counts = allocateCells(
    day.segments.map((segment) => segment.value),
    max,
    rows,
  );
  const cells: (string | null)[] = day.segments.flatMap((segment, index) =>
    Array.from({ length: counts[index] ?? 0 }, () => seriesColor(segment.colorIndex)),
  );
  while (cells.length < rows) cells.push(null);
  return cells;
}

export const UsageTimelineChart = memo(UsageTimelineChartImpl);
