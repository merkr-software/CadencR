import type { UsageSeries } from "./usage-stats-model";
import { formatCompactWords, formatExactWords, seriesColor } from "./usage-chart-palette";

/**
 * Always rendered when a chart has any series — identity must never rest on
 * color alone. Each entry direct-labels its own total, so the ranking is
 * readable without hovering a single bar.
 */
export function UsageChartLegend({ series }: { series: UsageSeries[] }): React.JSX.Element | null {
  if (series.length === 0) return null;

  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {series.map((entry) => (
        <li
          key={entry.key}
          className="flex items-center gap-1.5 text-[11px]"
          title={`${entry.label} — ${formatExactWords(entry.inputWords)} sent, ${formatExactWords(
            entry.outputWords,
          )} received`}
        >
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-[2px]"
            style={{ backgroundColor: seriesColor(entry.colorIndex) }}
          />
          <span className="text-muted-foreground">{entry.label}</span>
          <span className="tabular-nums text-foreground">{formatCompactWords(entry.value)}</span>
        </li>
      ))}
    </ul>
  );
}
