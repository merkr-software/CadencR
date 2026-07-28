import type { UsageDay } from "./usage-stats-model";
import { formatDayLabel, formatExactNumber } from "./usage-chart-palette";

interface UsageChartTooltipProps {
  day: UsageDay;
  labels: Map<string, string>;
  colors: Map<string, string>;
  /** What the numbers count, e.g. "tokens exchanged". */
  unit: string;
}

/**
 * Breakdown for the hovered day. Pinned above the plot rather than following
 * the cursor: the settings pane is narrow, and a floating tooltip would clip
 * against the card on the first and last columns.
 *
 * Identity is never color-alone here — every row pairs its swatch with the
 * series name.
 */
export function UsageChartTooltip({
  day,
  labels,
  colors,
  unit,
}: UsageChartTooltipProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute -top-1 right-0 z-10 min-w-[180px] max-w-[260px] rounded-lg border border-border/60 bg-popover p-2.5 text-xs shadow-lg"
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="font-medium text-foreground">{formatDayLabel(day.day)}</span>
        <span className="text-[11px] text-muted-foreground">
          {formatExactNumber(day.total)} {unit}
        </span>
      </div>
      {day.segments.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No usage.</p>
      ) : (
        <ul className="space-y-1">
          {day.segments.map((segment) => (
            <li key={segment.key} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: colors.get(segment.key) }}
                />
                <span className="truncate text-muted-foreground">
                  {labels.get(segment.key) ?? segment.key}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-foreground">
                {formatExactNumber(segment.value)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
