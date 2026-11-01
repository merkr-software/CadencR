import { useMemo } from "react";
import { SearchX } from "lucide-react";
import { VirtuosoGrid } from "react-virtuoso";
import type { MarketplaceListing, PluginKind } from "@/lib/marketplace-listings";
import { cn } from "@/lib/utils";
import { AGENT_KIND_ORDER, KIND_ORDER, KINDS } from "./kinds";
import type { AgentExtensionKind } from "@/lib/agent-extensions";
import { GridList, SHELF_SIZE, ShelfFrame } from "./MarketplaceGrid";
import { MarketplaceEmpty, TILE_GRID } from "./MarketplaceStates";
import { MarketplaceTile } from "./MarketplaceTile";

export type KindFilter = PluginKind | AgentExtensionKind | "all";

/**
 * Kind filter: every kind the catalog serves, with how many plugins each has,
 * then the kinds the agent CLIs install (counted once their catalogs answered).
 */
export function KindFilterBar({
  listings,
  kind,
  onKindChange,
  agentKinds = [],
}: {
  listings: MarketplaceListing[];
  kind: KindFilter;
  onKindChange: (kind: KindFilter) => void;
  agentKinds?: { kind: AgentExtensionKind; count?: number }[];
}): React.JSX.Element {
  const options: { value: KindFilter; label: string; count?: number; tone?: string }[] = [
    // Agent kinds have no total, so "All" carries a count only without them.
    { value: "all", label: "All", count: agentKinds.length ? undefined : listings.length },
    ...KIND_ORDER.filter(
      (value) => value === kind || listings.some((listing) => listing.contributes.includes(value)),
    ).map((value) => ({
      value,
      label: KINDS[value].plural,
      count: listings.filter((listing) => listing.contributes.includes(value)).length,
      tone: KINDS[value].tone,
    })),
    ...AGENT_KIND_ORDER.flatMap((value) => {
      const agent = agentKinds.find((item) => item.kind === value);
      return agent || value === kind
        ? [{ value, label: KINDS[value].plural, count: agent?.count, tone: KINDS[value].tone }]
        : [];
    }),
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
            {option.count !== undefined && (
              <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                {option.count}
              </span>
            )}
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
  return (
    <ShelfFrame
      kind={kind}
      count={listings.length}
      seeAll={listings.length > SHELF_SIZE ? `See all ${listings.length}` : undefined}
      onSeeAll={onSeeAll}
    >
      <div className={TILE_GRID}>
        {listings.slice(0, SHELF_SIZE).map((listing) => (
          <MarketplaceTile key={listing.key} listing={listing} />
        ))}
      </div>
    </ShelfFrame>
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
    () =>
      kind === "all" ? listings : listings.filter((l) => l.contributes.some((c) => c === kind)),
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
