import { forwardRef, useMemo, type HTMLAttributes } from "react";
import { SearchX } from "lucide-react";
import { VirtuosoGrid } from "react-virtuoso";
import { Button } from "@/components/ui/button";
import type { MarketplaceListing, PluginKind } from "@/lib/marketplace-listings";
import { cn } from "@/lib/utils";
import { KIND_ORDER, KINDS } from "./kinds";
import { MarketplaceEmpty, TILE_GRID } from "./MarketplaceStates";
import { MarketplaceTile } from "./MarketplaceTile";

export type KindFilter = PluginKind | "all";
const SHELF_SIZE = 8;

const GridList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function GridList(
  { className, ...props },
  ref,
) {
  return <div ref={ref} {...props} className={cn(TILE_GRID, className)} />;
});

/** Kind filter: every kind the catalog serves, with how many plugins each has. */
export function KindFilterBar({
  listings,
  kind,
  onKindChange,
}: {
  listings: MarketplaceListing[];
  kind: KindFilter;
  onKindChange: (kind: KindFilter) => void;
}): React.JSX.Element {
  const options: { value: KindFilter; label: string; count: number; tone?: string }[] = [
    { value: "all", label: "All", count: listings.length },
    ...KIND_ORDER.filter(
      (value) => value === kind || listings.some((listing) => listing.contributes.includes(value)),
    ).map((value) => ({
      value,
      label: KINDS[value].plural,
      count: listings.filter((listing) => listing.contributes.includes(value)).length,
      tone: KINDS[value].tone,
    })),
  ];
  return (
    <div role="group" aria-label="Plugin type" className="flex flex-wrap items-center gap-1.5">
      {options.map((option) => {
        const Icon = option.value === "all" ? null : KINDS[option.value].icon;
        const checked = kind === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={checked}
            onClick={() => onKindChange(option.value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              option.tone,
              checked
                ? "border-foreground/25 bg-foreground/8 text-foreground"
                : "border-border/80 text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {Icon && <Icon aria-hidden="true" className="size-3.5 text-[var(--mp-kind)]" />}
            {option.label}
            <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
              {option.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Shelf({
  kind,
  listings,
  onSeeAll,
}: {
  kind: PluginKind;
  listings: MarketplaceListing[];
  onSeeAll: () => void;
}): React.JSX.Element {
  const meta = KINDS[kind];
  const Icon = meta.icon;
  const shown = listings.slice(0, SHELF_SIZE);
  return (
    <section aria-labelledby={`mp-shelf-${kind}`} className={cn("space-y-3", meta.tone)}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 id={`mp-shelf-${kind}`} className="flex items-center gap-2 text-[15px] font-semibold">
            <Icon aria-hidden="true" className="size-4 text-[var(--mp-kind)]" />
            {meta.plural}
            <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">
              {listings.length}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">{meta.pitch}</p>
        </div>
        {listings.length > SHELF_SIZE && (
          <Button variant="ghost" size="xs" onClick={onSeeAll}>
            See all {listings.length}
          </Button>
        )}
      </div>
      <div className={TILE_GRID}>
        {shown.map((listing) => (
          <MarketplaceTile key={listing.key} listing={listing} />
        ))}
      </div>
    </section>
  );
}

/** Discover: one shelf per kind, or one virtualized grid once filtered or searched. */
export function MarketplaceDiscover({
  listings,
  kind,
  searching,
  onKindChange,
  scrollParent,
}: {
  listings: MarketplaceListing[];
  kind: KindFilter;
  searching: boolean;
  onKindChange: (kind: KindFilter) => void;
  scrollParent: HTMLElement | null;
}): React.JSX.Element {
  const visible = useMemo(
    () => (kind === "all" ? listings : listings.filter((l) => l.contributes.includes(kind))),
    [listings, kind],
  );
  if (!visible.length)
    return (
      <MarketplaceEmpty
        icon={SearchX}
        title="Nothing matches"
        detail="Try another name, publisher or type."
      />
    );
  if (kind === "all" && !searching)
    return (
      <div className="space-y-8">
        {KIND_ORDER.map((value) => {
          const shelf = visible.filter((listing) => listing.contributes.includes(value));
          return shelf.length ? (
            <Shelf key={value} kind={value} listings={shelf} onSeeAll={() => onKindChange(value)} />
          ) : null;
        })}
      </div>
    );
  return scrollParent ? (
    <VirtuosoGrid
      data={visible}
      customScrollParent={scrollParent}
      components={{ List: GridList }}
      computeItemKey={(_, listing) => listing.key}
      itemContent={(_, listing) => <MarketplaceTile listing={listing} />}
    />
  ) : (
    <div />
  );
}
