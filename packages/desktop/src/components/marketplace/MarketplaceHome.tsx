// Design contract and anatomy: DESIGN.md › Marketplace.
import { useEffect, useMemo, useState } from "react";
import { Blocks, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { matchesListing, spotlightListings } from "@/lib/marketplace-listings";
import { sidebarFilterTerms } from "@/lib/sidebar-filter";
import { cn } from "@/lib/utils";
import { useMarketplaceState } from "./MarketplaceContext";
import { MarketplaceActivity } from "./MarketplaceActivity";
import { KindFilterBar, MarketplaceDiscover, type KindFilter } from "./MarketplaceDiscover";
import { MarketplaceLibrary } from "./MarketplaceLibrary";
import { MarketplaceSpotlight } from "./MarketplaceSpotlight";
import {
  CheckCatalogButton,
  MarketplaceSkeleton,
  MarketplaceNotInBuild,
  MarketplaceUnavailable,
} from "./MarketplaceStates";
import { formatAgo } from "@/lib/date-utils";

export const MARKETPLACE_VIEWS = ["discover", "installed", "updates"] as const;
export type MarketplaceView = (typeof MARKETPLACE_VIEWS)[number];

function isMarketplaceView(value: string): value is MarketplaceView {
  return (MARKETPLACE_VIEWS as readonly string[]).includes(value);
}

export interface MarketplaceHomeProps {
  view: MarketplaceView;
  kind: KindFilter;
  query: string;
  onChange: (next: { view?: MarketplaceView; kind?: KindFilter; query?: string }) => void;
}

function newestDate(...values: (string | null | undefined)[]): string | null {
  return (
    values
      .filter((v): v is string => !!v)
      .sort()
      .at(-1) ?? null
  );
}

export function MarketplaceHome({
  view,
  kind,
  query,
  onChange,
}: MarketplaceHomeProps): React.JSX.Element {
  const state = useMarketplaceState();
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const searched = useMemo(() => {
    const terms = sidebarFilterTerms(query);
    return state.browsable.filter((listing) => matchesListing(listing, terms));
  }, [state.browsable, query]);
  const summary = useMemo(
    () => ({
      installed: state.browsable.filter((l) => l.installed).length,
      updates: state.browsable.filter((l) => l.update).length,
      inCatalog: state.browsable.filter((l) => l.inCatalog).length,
    }),
    [state.browsable],
  );
  const installed = useMemo(() => searched.filter((l) => l.installed), [searched]);
  const updates = useMemo(() => searched.filter((l) => l.update), [searched]);
  const spotlight = useMemo(() => spotlightListings(state.browsable), [state.browsable]);
  const { publishedAt, refreshing, anyCatalog } = catalogStatus(state);
  const refresh = () => {
    state.providers.refresh.mutate();
    state.themes.refresh.mutate();
    state.tabs.refresh.mutate();
  };
  return (
    <div data-feature-chrome="standard" className="flex h-full flex-col bg-background">
      <MarketplaceHeader
        view={view}
        query={query}
        onChange={onChange}
        counts={summary}
        summary={
          state.loading
            ? "Loading the verified catalog…"
            : [
                `${summary.inCatalog} plugins`,
                publishedAt && `catalog published ${formatAgo(publishedAt)}`,
              ]
                .filter(Boolean)
                .join(" · ")
        }
        refreshing={refreshing}
        onRefresh={refresh}
      />
      <div ref={setScrollParent} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-6 px-5 py-5">
          <MarketplaceActivity />
          {state.loading ? (
            <MarketplaceSkeleton />
          ) : view === "discover" ? (
            <>
              {!anyCatalog &&
                (state.catalogMissing ? (
                  <MarketplaceNotInBuild />
                ) : (
                  <MarketplaceUnavailable refreshing={refreshing} onRefresh={refresh} />
                ))}
              {!query && <MarketplaceSpotlight listings={spotlight} />}
              {searched.length > 0 && (
                <KindFilterBar
                  listings={searched}
                  kind={kind}
                  onKindChange={(next) => onChange({ kind: next })}
                />
              )}
              {(anyCatalog || searched.length > 0) && (
                <MarketplaceDiscover
                  listings={searched}
                  kind={kind}
                  searching={!!query.trim()}
                  onKindChange={(next) => onChange({ kind: next })}
                  scrollParent={scrollParent}
                />
              )}
            </>
          ) : (
            <MarketplaceLibrary
              view={view}
              listings={view === "updates" ? updates : installed}
              scrollParent={scrollParent}
              publishedAt={publishedAt}
              refreshing={refreshing}
              onRefresh={refresh}
              onDiscover={() => onChange({ view: "discover" })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MarketplaceHeader({
  view,
  query,
  onChange,
  counts,
  summary,
  refreshing,
  onRefresh,
}: Pick<MarketplaceHomeProps, "view" | "query" | "onChange"> & {
  counts: { installed: number; updates: number };
  summary: string;
  refreshing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  return (
    <header className="titlebar-drag flex shrink-0 flex-col gap-3 border-b border-border/60 px-5 pt-4">
      <div className="flex items-center gap-3">
        <SidebarCollapsedChrome visible={collapsed} onExpand={() => setCollapsed(false)} />
        <Blocks aria-hidden="true" className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold leading-tight">Marketplace</h1>
          <p className="truncate text-xs text-muted-foreground">{summary}</p>
        </div>
        <CheckCatalogButton
          refreshing={refreshing}
          onRefresh={onRefresh}
          label={<span className="hidden sm:inline">Check for updates</span>}
        />
      </div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <Tabs
          value={view}
          onValueChange={(next) => {
            if (isMarketplaceView(next)) onChange({ view: next });
          }}
          className="min-w-0"
        >
          <TabsList aria-label="Marketplace views" className="h-9 w-auto border-b-0">
            <TabsTrigger value="discover">Discover</TabsTrigger>
            <TabsTrigger value="installed">
              Installed <Count value={counts.installed} />
            </TabsTrigger>
            <TabsTrigger value="updates">
              Updates <Count value={counts.updates} highlight={counts.updates > 0} />
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <SearchField query={query} onChange={onChange} />
      </div>
    </header>
  );
}

/**
 * Typing stays local; the URL (and the filter that reads it) follows once the
 * user pauses, so a keystroke never waits on a router navigation.
 */
function SearchField({
  query,
  onChange,
}: Pick<MarketplaceHomeProps, "query" | "onChange">): React.JSX.Element {
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  useEffect(() => {
    if (draft === query) return;
    const timer = setTimeout(() => onChange({ query: draft }), 250);
    return () => clearTimeout(timer);
  }, [draft, query, onChange]);
  return (
    <div className="relative mb-2 ml-auto w-full sm:w-64">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        aria-label="Search the marketplace"
        placeholder="Search plugins, publishers…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="h-8 pl-8 text-[13px]"
      />
    </div>
  );
}

function Count({
  value,
  highlight = false,
}: {
  value: number;
  highlight?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] tabular-nums",
        highlight ? "bg-primary text-primary-foreground" : "bg-foreground/8 text-muted-foreground",
      )}
    >
      {value}
    </span>
  );
}

function catalogStatus(state: ReturnType<typeof useMarketplaceState>) {
  const publishedAt = newestDate(
    state.providers.catalogQuery.data?.index?.signed.generated_at,
    state.themes.catalog.data?.index?.signed.generated_at,
    state.tabs.catalog.data?.index?.signed.generated_at,
  );
  const refreshing =
    state.providers.refresh.isPending ||
    state.themes.refresh.isPending ||
    state.tabs.refresh.isPending;
  const anyCatalog =
    state.catalogUsable.provider || state.catalogUsable.theme || state.catalogUsable.tab;
  return { publishedAt, refreshing, anyCatalog };
}
