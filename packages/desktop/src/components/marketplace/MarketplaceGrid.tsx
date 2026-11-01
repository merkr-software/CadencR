import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { KINDS, type MarketplaceKind } from "./kinds";
import { TILE_GRID } from "./MarketplaceStates";

/** Tiles a Discover shelf shows before "See all". */
export const SHELF_SIZE = 8;

/** VirtuosoGrid's list element: the tile grid. */
export const GridList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function GridList({ className, ...props }, ref) {
    return <div ref={ref} {...props} className={cn(TILE_GRID, className)} />;
  },
);

export function TileGridSkeleton(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading" className={TILE_GRID}>
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="aspect-[4/3.4] rounded-lg" />
      ))}
    </div>
  );
}

/** One kind's shelf on Discover: its title, pitch and "See all", above its tiles. */
export function ShelfFrame({
  kind,
  count,
  seeAll,
  onSeeAll,
  children,
}: {
  kind: MarketplaceKind;
  /** Shown next to the title when the kind has a known total. */
  count?: number;
  /** The "See all" label; none hides the button. */
  seeAll?: string;
  onSeeAll: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const meta = KINDS[kind];
  const Icon = meta.icon;
  return (
    <section aria-labelledby={`mp-shelf-${kind}`} className={cn("space-y-3", meta.tone)}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 id={`mp-shelf-${kind}`} className="flex items-center gap-2 text-[15px] font-semibold">
            <Icon aria-hidden="true" className="size-4 text-[var(--mp-kind)]" />
            {meta.plural}
            {count !== undefined && (
              <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
                {count}
              </span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground">{meta.pitch}</p>
        </div>
        {seeAll && (
          <Button variant="ghost" size="xs" onClick={onSeeAll}>
            {seeAll}
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}
