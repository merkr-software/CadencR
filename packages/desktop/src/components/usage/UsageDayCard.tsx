import type { UsageDay, UsageMetric, UsageScale } from "./usage-stats-model";
import { formatDayLabel, formatShare, formatUsageValue, seriesColor } from "./usage-chart-palette";

/**
 * A day's breakdown, in the card of its column: the date and total, then what
 * each series used that day. In the share view each row reads its part of the
 * day instead of its own figure.
 */
export function UsageDayCard({
  day,
  labelOf,
  scale,
  metric,
}: {
  day: UsageDay;
  labelOf: (seriesKey: string) => string;
  scale: UsageScale;
  metric: UsageMetric;
}): React.JSX.Element {
  return (
    <div className="min-w-40 space-y-2 text-xs">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-medium text-foreground">{formatDayLabel(day.day)}</span>
        <span className="tabular-nums text-muted-foreground">
          {formatUsageValue(day.total, metric)}
        </span>
      </div>
      <ul className="space-y-1.5">
        {day.segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: seriesColor(segment.colorIndex) }}
            />
            <span className="min-w-0 text-muted-foreground">{labelOf(segment.key)}</span>
            <span className="ml-auto pl-4 tabular-nums text-foreground">
              {scale === "share"
                ? formatShare(segment.value, day.total)
                : formatUsageValue(segment.value, metric)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
