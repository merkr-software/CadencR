import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildListings } from "@/lib/marketplace-listings";
import { isStandalone } from "@/lib/marketplace-plugin-listings";
import { providerCatalogQuery, providerInventoryQuery } from "./useMarketplace";
import { tabCatalogQuery, tabInventoryQuery } from "./useTabMarketplace";
import { themeCatalogQuery } from "./useThemeMarketplace";
import { useManagedThemes } from "./useManagedThemes";

const BADGE_REFRESH_MS = 15 * 60_000;

/** False until the renderer first goes idle, so a badge never competes with boot. */
function useAfterIdle(): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(() => setIdle(true), { timeout: 5_000 });
      return () => cancelIdleCallback(handle);
    }
    const timer = setTimeout(() => setIdle(true), 2_000);
    return () => clearTimeout(timer);
  }, []);
  return idle;
}

/**
 * How many installed plugins have a newer compatible version. Reads the same
 * cache entries as the marketplace page, so opening it costs no extra request;
 * failures surface on the page itself, never in the badge.
 */
export function useMarketplaceUpdateCount(): number {
  const enabled = useAfterIdle();
  const badge = { enabled, refetchInterval: BADGE_REFRESH_MS } as const;
  const providerCatalog = useQuery({ ...providerCatalogQuery, ...badge }).data;
  const providerInventory = useQuery({ ...providerInventoryQuery, ...badge }).data;
  const themeCatalog = useQuery({ ...themeCatalogQuery, ...badge }).data;
  const themeInventory = useManagedThemes().data;
  const tabCatalog = useQuery({ ...tabCatalogQuery, ...badge }).data;
  const tabInventory = useQuery({ ...tabInventoryQuery, ...badge }).data;
  return useMemo(
    () =>
      buildListings({
        providerCatalog,
        providerInventory: providerInventory?.providers,
        themeCatalog,
        themeInventory,
        tabCatalog,
        tabInventory,
        // A plugin's members update with it: its one update is the one counted.
      }).filter((listing) => listing.update && isStandalone(listing)).length,
    [providerCatalog, providerInventory, themeCatalog, themeInventory, tabCatalog, tabInventory],
  );
}
