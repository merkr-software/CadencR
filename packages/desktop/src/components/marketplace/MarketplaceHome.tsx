import { useUiTranslation } from "@/lib/i18n/ui";
// Design contract and anatomy: DESIGN.md › Marketplace.
import { useEffect, useMemo, useState } from "react";
import { Blocks, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import {
  matchesListing,
  spotlightListings,
  type MarketplaceListing,
} from "@/lib/marketplace-listings";
import { isStandalone } from "@/lib/marketplace-plugin-listings";
import { sidebarFilterTerms } from "@/lib/sidebar-filter";
import { cn } from "@/lib/utils";
import { useMarketplaceState } from "./MarketplaceContext";
import { MarketplaceActivity } from "./MarketplaceActivity";
import { MarketplaceTrustNotice } from "./MarketplaceTrustNotice";
import { KIND_ORDER, KINDS } from "./kinds";
import type { KindFilter } from "./MarketplaceDiscover";
import { CheckCatalogButton, MarketplaceSkeleton } from "./MarketplaceStates";
import { DiscoverView, LibraryView } from "./MarketplaceViews";
import {
  useAgentExtensionCounts,
  useExtensionClis,
  useRefreshAgentExtensions,
} from "@/hooks/useAgentExtensions";
import { isAgentExtensionKind } from "@/lib/agent-extensions";
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
  const searched = useSearchedListings(state.browsable, query);
  // Plugin members are browsed through their plugin (one tile, one update) but
  // stay listed in Installed, where each says which plugin it is part of.
  const standalone = useMemo(() => state.browsable.filter(isStandalone), [state.browsable]);
  const clis = useExtensionClis();
  const cliList = useMemo(() => clis.data?.clis ?? [], [clis.data]);
  const agentCounts = useAgentExtensionCounts(cliList.some((cli) => cli.installed));
  const refreshAgents = useRefreshAgentExtensions();
  const summary = useMemo(
    () => ({
      installed: state.browsable.filter((l) => l.installed).length + agentCounts.installed,
      updates: standalone.filter((l) => l.update).length + agentCounts.updates,
      inCatalog: standalone.filter((l) => l.inCatalog).length,
    }),
    [state.browsable, standalone, agentCounts],
  );
  const discover = useMemo(() => searched.filter(isStandalone), [searched]);
  const installed = useMemo(() => searched.filter((l) => l.installed), [searched]);
  const updates = useMemo(() => discover.filter((l) => l.update), [discover]);
  const spotlight = useMemo(() => spotlightListings(standalone), [standalone]);
  const status = catalogStatus(state);
  const { publishedAt, anyCatalog } = status;
  const refreshing = status.refreshing || refreshAgents.isPending;
  const refresh = () => {
    state.providers.refresh.mutate();
    state.themes.refresh.mutate();
    state.tabs.refresh.mutate();
    state.lsps.refresh.mutate();
    if (cliList.some((cli) => cli.installed)) refreshAgents.mutate();
  };
  const onKindChange = (next: KindFilter) => onChange({ kind: next });
  return (
    <div data-feature-chrome="standard" className="flex h-full flex-col bg-background">
      <MarketplaceHeader
        view={view}
        query={query}
        onChange={onChange}
        counts={summary}
        catalogLoading={state.loading}
        publishedAt={publishedAt}
        refreshing={refreshing}
        onRefresh={refresh}
      />
      <div ref={setScrollParent} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-6 px-5 py-5">
          <MarketplaceTrustNotice />
          <MarketplaceActivity />
          {state.loading && !isAgentExtensionKind(kind) ? (
            <MarketplaceSkeleton />
          ) : view === "discover" ? (
            <DiscoverView
              kind={kind}
              query={query}
              searched={discover}
              spotlight={spotlight}
              clis={cliList}
              anyCatalog={anyCatalog}
              catalogMissing={state.catalogMissing}
              refreshing={refreshing}
              onRefresh={refresh}
              onKindChange={onKindChange}
              scrollParent={scrollParent}
            />
          ) : (
            <LibraryView
              view={view}
              kind={kind}
              query={query}
              listings={view === "updates" ? updates : installed}
              scrollParent={scrollParent}
              publishedAt={publishedAt}
              refreshing={refreshing}
              onRefresh={refresh}
              onDiscover={() => onChange({ view: "discover" })}
              onKindChange={onKindChange}
              clis={cliList}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function useSearchedListings(listings: MarketplaceListing[], query: string) {
  const { t } = useUiTranslation();
  return useMemo(() => {
    const terms = sidebarFilterTerms(query);
    if (!terms.length) return listings;
    const kindLabels = new Map(
      [...KIND_ORDER, "plugin" as const].map((kind) => [
        kind,
        [KINDS[kind].label(t), KINDS[kind].plural(t)],
      ]),
    );
    return listings.filter((listing) =>
      matchesListing(
        listing,
        terms,
        [listing.kind, ...listing.contributes].flatMap((kind) => kindLabels.get(kind) ?? []),
      ),
    );
  }, [listings, query, t]);
}

function CatalogSummary({
  count,
  loading,
  publishedAt,
}: {
  count: number;
  loading: boolean;
  publishedAt: string | null;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const summary = loading
    ? t("marketplace.marketplaceHome.catalogLoading", "Loading the verified catalog…")
    : [
        t("marketplace.marketplaceHome.catalogCount", "{{count}} plugins", {
          count,
          defaultValue_zero: "{{count}} plugins",
          defaultValue_one: "{{count}} plugin",
        }),
        publishedAt &&
          t("marketplace.marketplaceHome.catalogPublished", "catalog published {{published}}", {
            published: formatAgo(publishedAt),
          }),
      ]
        .filter(Boolean)
        .join(" · ");
  return <p className="truncate text-xs text-muted-foreground">{summary}</p>;
}

function MarketplaceHeader({
  view,
  query,
  onChange,
  counts,
  catalogLoading,
  publishedAt,
  refreshing,
  onRefresh,
}: Pick<MarketplaceHomeProps, "view" | "query" | "onChange"> & {
  counts: { installed: number; updates: number; inCatalog: number };
  catalogLoading: boolean;
  publishedAt: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  return (
    <header className="titlebar-drag flex shrink-0 flex-col gap-3 border-b border-border/60 px-5 pt-4">
      <div className="flex items-center gap-3">
        <SidebarCollapsedChrome visible={collapsed} onExpand={() => setCollapsed(false)} />
        <Blocks aria-hidden="true" className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold leading-tight">
            {t("marketplace.marketplaceHome.marketplace", "Marketplace")}
          </h1>
          <CatalogSummary
            count={counts.inCatalog}
            loading={catalogLoading}
            publishedAt={publishedAt}
          />
        </div>
        <CheckCatalogButton
          refreshing={refreshing}
          onRefresh={onRefresh}
          label={
            <span className="hidden sm:inline">
              {t("marketplace.marketplaceHome.checkForUpdates", "Check for updates")}
            </span>
          }
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
          <TabsList
            aria-label={t("marketplace.marketplaceHome.marketplaceViews", "Marketplace views")}
            className="h-9 w-auto border-b-0"
          >
            <TabsTrigger value="discover">
              {t("marketplace.marketplaceHome.discover", "Discover")}
            </TabsTrigger>
            <TabsTrigger value="installed">
              {t("marketplace.marketplaceHome.installed", "Installed")}{" "}
              <Count value={counts.installed} />
            </TabsTrigger>
            <TabsTrigger value="updates">
              {t("marketplace.marketplaceHome.updates", "Updates")}{" "}
              <Count value={counts.updates} highlight={counts.updates > 0} />
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
  const { t } = useUiTranslation();
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
        aria-label={t("marketplace.marketplaceHome.searchTheMarketplace", "Search the marketplace")}
        placeholder={t(
          "marketplace.marketplaceHome.searchPluginsSkillsMcpServers",
          "Search plugins, skills, MCP servers…",
        )}
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
    state.lsps.catalog.data?.index?.signed.generated_at,
  );
  const refreshing =
    state.providers.refresh.isPending ||
    state.themes.refresh.isPending ||
    state.tabs.refresh.isPending ||
    state.lsps.refresh.isPending;
  const anyCatalog =
    state.catalogUsable.provider ||
    state.catalogUsable.theme ||
    state.catalogUsable.tab ||
    state.catalogUsable.lsp;
  return { publishedAt, refreshing, anyCatalog };
}
