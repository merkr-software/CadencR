import { memo, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { UsageChartData, UsageDay } from "./usage-stats-model";
import {
  formatCompactWords,
  formatDayLabel,
  formatExactWords,
  seriesColor,
} from "./usage-chart-palette";
import { UsageChartTooltip } from "./UsageChartTooltip";
import { axisTickIndexes } from "./usage-axis";

const PLOT_HEIGHT_PX = 156;
/** Keeps a non-zero day from vanishing into a sub-pixel sliver. */
const MIN_SEGMENT_PX = 2;

interface UsageTimelineChartProps {
  data: UsageChartData;
  /** Names the measure the bar heights encode, e.g. "words exchanged". */
  metricLabel: string;
  emptyMessage: string;
}

/**
 * Stacked-bar timeline: one column per day, one segment per series.
 *
 * Plain flex-box bars rather than SVG — the column widths then track the
 * settings pane's own width with no layout measurement, which keeps this off
 * the "read layout on every resize" path.
 */
function UsageTimelineChartImpl({
  data,
  metricLabel,
  emptyMessage,
}: UsageTimelineChartProps): React.JSX.Element {
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);

  const labels = useMemo(
    () => new Map(data.series.map((series) => [series.key, series.label])),
    [data.series],
  );
  const colors = useMemo(
    () => new Map(data.series.map((series) => [series.key, seriesColor(series.colorIndex)])),
    [data.series],
  );
  const hovered = useMemo(
    () => data.days.find((day) => day.day === hoveredDay) ?? null,
    [data.days, hoveredDay],
  );
  const axisTicks = useMemo(() => axisTickIndexes(data.days.length), [data.days.length]);

  if (data.max === 0) {
    return (
      <div className="grid h-[196px] place-items-center rounded-lg border border-dashed border-border/60 px-6 text-center text-xs text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex gap-2">
        <YAxis max={data.max} />
        <div className="min-w-0 flex-1">
          <div
            className="relative flex items-end gap-[2px]"
            style={{ height: PLOT_HEIGHT_PX }}
            onMouseLeave={() => setHoveredDay(null)}
          >
            <Gridlines />
            {data.days.map((day) => (
              <DayColumn
                key={day.day}
                day={day}
                max={data.max}
                colors={colors}
                dimmed={hoveredDay !== null && hoveredDay !== day.day}
                metricLabel={metricLabel}
                onHover={setHoveredDay}
              />
            ))}
          </div>
          {/* Tick labels are wider than one column, so they are positioned
              over the plot rather than laid out inside it — a per-column cell
              would clip "Jun 26" down to "J…". */}
          <div className="relative mt-1.5 h-3">
            {data.days.map((day, index) =>
              axisTicks.has(index) ? (
                <span
                  key={day.day}
                  className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] leading-none text-muted-foreground"
                  style={{ left: `${((index + 0.5) / data.days.length) * 100}%` }}
                >
                  {formatDayLabel(day.day)}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>

      {hovered ? (
        <UsageChartTooltip day={hovered} labels={labels} colors={colors} unit={metricLabel} />
      ) : null}
    </div>
  );
}

function YAxis({ max }: { max: number }): React.JSX.Element {
  return (
    <div
      className="flex w-10 shrink-0 flex-col justify-between text-right text-[10px] leading-none text-muted-foreground"
      style={{ height: PLOT_HEIGHT_PX }}
      aria-hidden
    >
      <span>{formatCompactWords(max)}</span>
      <span>{formatCompactWords(max / 2)}</span>
      <span>0</span>
    </div>
  );
}

/** Recessive half and full gridlines; the bars sit above them. */
function Gridlines(): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div className="absolute inset-x-0 top-0 border-t border-border/40" />
      <div className="absolute inset-x-0 top-1/2 border-t border-border/40" />
      <div className="absolute inset-x-0 bottom-0 border-t border-border/70" />
    </div>
  );
}

interface DayColumnProps {
  day: UsageDay;
  max: number;
  colors: Map<string, string>;
  dimmed: boolean;
  metricLabel: string;
  onHover: (day: string | null) => void;
}

/**
 * Memoized because hovering flips `dimmed` on every column: without it a single
 * mouse move over a 90-day chart re-renders all 90 and rebuilds each one's
 * reversed segment list.
 */
const DayColumn = memo(function DayColumn({
  day,
  max,
  colors,
  dimmed,
  metricLabel,
  onHover,
}: DayColumnProps): React.JSX.Element {
  return (
    <div
      // The whole column is the hit target, not just the painted bar, so a
      // quiet day is as hoverable as a busy one.
      className="group relative flex h-full min-w-0 flex-1 cursor-default flex-col justify-end gap-[2px]"
      onMouseEnter={() => onHover(day.day)}
      onFocus={() => onHover(day.day)}
      onBlur={() => onHover(null)}
      tabIndex={0}
      role="img"
      aria-label={`${formatDayLabel(day.day)}: ${formatExactWords(day.total)} ${metricLabel}`}
    >
      {/* Bottom-up in stack order, so the largest series sits at the base. */}
      {[...day.segments].reverse().map((segment, index) => (
        <div
          key={segment.key}
          className={cn(
            "w-full transition-opacity duration-150",
            // Data-ends round; the segments below stay square so the stack
            // reads as one bar.
            index === day.segments.length - 1 && "rounded-t-[4px]",
            dimmed && "opacity-40",
          )}
          style={{
            height: `max(${MIN_SEGMENT_PX}px, ${(segment.value / max) * 100}%)`,
            backgroundColor: colors.get(segment.key),
          }}
        />
      ))}
    </div>
  );
});

export const UsageTimelineChart = memo(UsageTimelineChartImpl);
