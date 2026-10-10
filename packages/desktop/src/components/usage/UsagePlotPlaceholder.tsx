import { Skeleton } from "@/components/ui/skeleton";
import { cellScopeStyle, chartHeightCss, type UsageDensity } from "./usage-cell-grid";

/**
 * A box the size of the chart it stands in for, at any pane width, so nothing
 * moves when usage lands.
 */
export function UsagePlotPlaceholder({
  days,
  density,
  className,
  children,
}: {
  days: number;
  density: UsageDensity;
  className?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="@container w-full">
      <div
        className={className}
        style={{ ...cellScopeStyle(days), height: chartHeightCss(density) }}
      >
        {children}
      </div>
    </div>
  );
}

export function UsagePlotSkeleton({
  days,
  density,
}: {
  days: number;
  density: UsageDensity;
}): React.JSX.Element {
  return (
    <UsagePlotPlaceholder days={days} density={density}>
      <Skeleton className="size-full rounded-lg" aria-busy="true" aria-label="Loading usage" />
    </UsagePlotPlaceholder>
  );
}
