import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useMarketplace } from "@/hooks/useMarketplace";
import { useTabMarketplace } from "@/hooks/useTabMarketplace";
import { useThemeMarketplace } from "@/hooks/useThemeMarketplace";
import { useTheme } from "@/hooks/useTheme";
import { buildListings, type MarketplaceListing } from "@/lib/marketplace-listings";
import { browsableListings } from "@/lib/marketplace-platform";
import { listingIndex } from "@/lib/marketplace-plugin-listings";
import { catalogSourceMissing, usableCatalog } from "@/lib/marketplace";
import { usableThemeCatalog } from "@/lib/theme-marketplace";

/**
 * A plugin install walking its members: the member in flight, or the one it
 * stopped at and why. Cleared once every member is confirmed.
 */
export type PluginRun =
  | { key: string; status: "running"; member: string; step: number; total: number }
  | { key: string; status: "failed"; member: string; message: string };

interface MarketplaceState {
  providers: ReturnType<typeof useMarketplace>;
  themes: ReturnType<typeof useThemeMarketplace>;
  tabs: ReturnType<typeof useTabMarketplace>;
  /** Every known package: detail pages and the installed record read this. */
  listings: MarketplaceListing[];
  /** `listings` by key, so a plugin resolves its members without a scan each. */
  listingsByKey: ReadonlyMap<string, MarketplaceListing>;
  /** What browsing surfaces list: `listings` minus packages with no build for this platform. */
  browsable: MarketplaceListing[];
  themeLoading: boolean;
  loading: boolean;
  /** At least one kind has a current, verified catalog to install from. */
  catalogUsable: { provider: boolean; theme: boolean; tab: boolean };
  /** This build has no catalog feed and nothing cached: there is nothing to browse, by design. */
  catalogMissing: boolean;
  /** "Update all" is walking its queue (kept here so it survives navigation). */
  updatingAll: boolean;
  setUpdatingAll: (running: boolean) => void;
  /** The plugin install in progress or last stopped (kept here so it survives navigation). */
  pluginRun: PluginRun | null;
  setPluginRun: (run: PluginRun | null) => void;
}

const MarketplaceContext = createContext<MarketplaceState | null>(null);

/**
 * Owns all kinds' queries and mutations above the list and detail routes, so
 * a pending install, its result and its failure survive moving between them.
 */
export function MarketplaceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const providers = useMarketplace();
  const themes = useThemeMarketplace();
  const tabs = useTabMarketplace();
  const tabCatalog = tabs.catalog.data;
  const tabInventory = tabs.inventory.data;
  const tabSummaries = tabs.summaries.data;
  const { themeId, isLoading: themeLoading } = useTheme();
  const [updatingAll, setUpdatingAll] = useState(false);
  const [pluginRun, setPluginRun] = useState<PluginRun | null>(null);
  const providerCatalog = providers.catalogQuery.data;
  const providerInventory = providers.inventoryQuery.data;
  const themeCatalog = themes.catalog.data;
  const themeInventory = themes.inventory.data;
  const listings = useMemo(
    () =>
      buildListings({
        providerCatalog,
        providerInventory: providerInventory?.providers,
        themeCatalog,
        themeInventory,
        displayedThemeId: themeId,
        tabCatalog,
        tabInventory,
        tabSummaries,
      }),
    [
      providerCatalog,
      providerInventory,
      themeCatalog,
      themeInventory,
      themeId,
      tabCatalog,
      tabInventory,
      tabSummaries,
    ],
  );
  const listingsByKey = useMemo(() => listingIndex(listings), [listings]);
  const browsable = useMemo(() => browsableListings(listings), [listings]);
  const loading =
    providers.catalogQuery.isPending ||
    providers.inventoryQuery.isPending ||
    themes.catalog.isPending ||
    themes.inventory.isPending ||
    tabs.catalog.isPending ||
    tabs.inventory.isPending;
  const catalogUsable = useMemo(
    () => ({
      provider: usableCatalog(providerCatalog),
      theme: usableThemeCatalog(themeCatalog),
      tab: usableThemeCatalog(tabCatalog),
    }),
    [providerCatalog, themeCatalog, tabCatalog],
  );
  const catalogMissing =
    catalogSourceMissing(providerCatalog) &&
    !catalogUsable.provider &&
    !catalogUsable.theme &&
    !catalogUsable.tab;
  const value = useMemo(
    () => ({
      providers,
      themes,
      tabs,
      listings,
      listingsByKey,
      browsable,
      themeLoading,
      loading,
      catalogUsable,
      catalogMissing,
      updatingAll,
      setUpdatingAll,
      pluginRun,
      setPluginRun,
    }),
    [
      providers,
      themes,
      tabs,
      listings,
      listingsByKey,
      browsable,
      themeLoading,
      loading,
      catalogUsable,
      catalogMissing,
      updatingAll,
      pluginRun,
    ],
  );
  return <MarketplaceContext.Provider value={value}>{children}</MarketplaceContext.Provider>;
}

export function useMarketplaceState(): MarketplaceState {
  const state = useContext(MarketplaceContext);
  if (!state) throw new Error("useMarketplaceState must be used inside <MarketplaceProvider>");
  return state;
}
