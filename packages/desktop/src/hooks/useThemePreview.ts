import { useCallback, useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { previewManagedThemePackage, type SignedMixedCatalog } from "@/api/generated";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import {
  managedThemeDataSchema,
  managedThemeDefinition,
  usableThemeCatalog,
} from "@/lib/theme-marketplace";
import { toThemeDefinition } from "@/lib/themes/user-theme";
import type { ThemeDefinition } from "@/lib/themes";
import type { useThemeMarketplace } from "./useThemeMarketplace";

type ThemeState = ReturnType<typeof useThemeMarketplace>;
type ThemeIndex = SignedMixedCatalog | null | undefined;

/**
 * Previews in flight at once. Each holds a connection to the local service for
 * a whole GitHub round trip, and the browser allows only six per host: a full
 * shelf fetched at once would stall every other API call behind it.
 */
const PREVIEW_CONCURRENCY = 2;
let previewsInFlight = 0;
const previewQueue: (() => void)[] = [];

async function withPreviewSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (previewsInFlight < PREVIEW_CONCURRENCY) previewsInFlight += 1;
  // A finishing preview hands its slot straight to the next one in line.
  else await new Promise<void>((resolve) => previewQueue.push(resolve));
  try {
    signal.throwIfAborted();
    return await run();
  } finally {
    const next = previewQueue.shift();
    if (next) next();
    else previewsInFlight -= 1;
  }
}

/**
 * A verified preview of one exact catalog version. The key carries the archive
 * digest and the catalog signature, so a changed catalog never shows a stale
 * preview. Fetching downloads and validates the (small, declarative) archive
 * without installing it; it runs as soon as an uninstalled theme is shown.
 */
function themePreviewQuery(
  id: string,
  version: string,
  sha256: string | undefined,
  index: ThemeIndex,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: ["marketplace", "theme-preview", id, version, sha256, index?.signature.value],
    enabled,
    // The key pins the archive digest, so a cached preview can never go stale.
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
    // The request goes to the local service, so a browser offline flag must
    // not park it without a spinner or an error.
    networkMode: "always",
    queryFn: async ({ signal }) => {
      if (!index) throw new Error("A current signed catalog is required to preview a theme.");
      const response = await withPreviewSlot(signal, () =>
        previewManagedThemePackage({ theme_id: id, version, index }, signal),
      );
      const parsed = managedThemeDataSchema.parse(response);
      return toThemeDefinition(id, parsed.theme, parsed.assets);
    },
  });
}

function digestOf(listing: MarketplaceListing, version: string): string | undefined {
  return listing.versions.find((entry) => entry.version === version)?.sha256;
}

interface ThemeArt {
  definition: ThemeDefinition | null;
  /** True when the definition is the installed revision rather than a preview. */
  installed: boolean;
  /** A preview can be fetched: the version is in the current, verified signed catalog. */
  canPreview: boolean;
  loading: boolean;
  error: unknown;
  /** Fetch the preview again (after a failure). */
  retry: () => void;
}

/** The colors a theme listing is painted with: installed document, else its verified preview. */
export function useThemeArt(
  themes: ThemeState,
  listing: MarketplaceListing,
  version: string | undefined,
): ThemeArt {
  const entry = themes.inventory.data?.find((item) => item.id === listing.id);
  const installedDefinition = useMemo(
    () => (entry?.theme && entry.version === version ? managedThemeDefinition(entry) : null),
    [entry, version],
  );
  const index = themes.catalog.data?.index;
  const sha256 = version ? digestOf(listing, version) : undefined;
  const canPreview = usableThemeCatalog(themes.catalog.data) && !!version && !!sha256;
  // Until the inventory answers, an installed theme would look uninstalled.
  const enabled = canPreview && !installedDefinition && !themes.inventory.isPending;
  const query = useQuery(themePreviewQuery(listing.id, version ?? "", sha256, index, enabled));
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  return {
    definition: installedDefinition ?? query.data ?? null,
    installed: !!installedDefinition,
    canPreview,
    // Waiting on the catalog or inventory is loading too, not "no preview".
    loading:
      query.isFetching ||
      themes.catalog.isPending ||
      (canPreview && !installedDefinition && themes.inventory.isPending),
    error: query.error,
    retry,
  };
}
