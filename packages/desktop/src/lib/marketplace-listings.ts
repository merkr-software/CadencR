import { lspListings } from "./marketplace-lsp-listings";
import type { LspCatalog, LspInventory } from "./lsp/marketplace";
import type {
  ManagedCatalogResponse,
  ManagedProviderInventoryEntry,
  ManagedProviderPackage,
  ManagedThemeCatalogResponse,
  ManagedTabInventoryEntry,
  PluginTabSummary,
} from "@/api/generated";
import {
  runtimeNativeCode,
  tabNativeCode,
  type TabMarketplacePackage,
} from "./marketplace-tab-package";
import { z } from "zod";
import { groupPackages, installedRevision, providerCatalogPackages } from "./marketplace";
import { groupTabPackages } from "./marketplace-catalog";
import { pluginListings } from "./marketplace-plugin-listings";
import { matchesSidebarFilter } from "./sidebar-filter";
import {
  baseListing,
  listingKey,
  pickMeta,
  type InstalledState,
  type ListingVersion,
  type MarketplaceListing,
} from "./marketplace-listing-base";
import type { ThemeMarketplacePackage } from "./marketplace-theme-package";
import { groupThemePackages, type managedThemeEntrySchema } from "./theme-marketplace";

export {
  isListingKind,
  PLUGIN_KINDS,
  type ListingKind,
  type MarketplaceListing,
  type PluginKind,
  type PluginMemberRef,
} from "./marketplace-listing-base";
type ManagedThemeEntry = z.infer<typeof managedThemeEntrySchema>;

/** The version a listing currently stands for: installed, else the one on offer. */
export function displayVersion(listing: MarketplaceListing): string | undefined {
  return listing.installed?.version ?? listing.recommended ?? listing.versions[0]?.version;
}

/** The version a detail page offers first: a pending update wins over what is installed. */
export function offeredVersion(listing: MarketplaceListing): string {
  return listing.update ?? listing.installed?.version ?? listing.recommended ?? "";
}

/**
 * The update a user can still download: one already staged (downloaded and
 * verified) only waits for its review, which its badge asks for instead.
 */
export function downloadableUpdate(listing: MarketplaceListing): string | undefined {
  return listing.update === listing.pendingVersion ? undefined : listing.update;
}

/** Install and last-change dates, read from the confirmed history (newest event wins). */
export function providerDates(entry: ManagedProviderInventoryEntry): {
  installedAt?: string;
  updatedAt?: string;
} {
  const history = [...entry.history].sort((a, b) => a.sequence - b.sequence);
  const installed = history.filter((event) => event.action === "installed").at(-1);
  const changed = history
    .filter((event) => ["installed", "updated", "rolled_back"].includes(event.action))
    .at(-1);
  return { installedAt: installed?.occurred_at, updatedAt: changed?.occurred_at };
}

function providerInstalled(entry: ManagedProviderInventoryEntry): InstalledState | undefined {
  if (!installedRevision(entry)) return undefined;
  return {
    version: entry.version ?? null,
    active: entry.active_now,
    usable: true,
    enabled: entry.enabled_after_restart,
    restartRequired: entry.restart_required,
    error: entry.error,
    ...providerDates(entry),
  };
}

function themeInstalled(entry: ManagedThemeEntry, displayedThemeId?: string): InstalledState {
  return {
    version: entry.version,
    active: displayedThemeId === `managed:${entry.id}`,
    usable: !!entry.theme,
    selected: entry.active,
    restartRequired: false,
    error: entry.error,
  };
}

function providerVersion(item: ManagedProviderPackage, catalog?: ManagedCatalogResponse) {
  // The service decides what installs here, with the installer's own check.
  const unavailable = catalog?.unavailable_versions?.[item.agent.id]?.[item.agent.version];
  return {
    version: item.agent.version,
    minApp: item.host.compatibility.min_app_version,
    maxApp: item.host.compatibility.max_app_version,
    platforms: Object.keys(item.agent.distribution?.binary ?? {}),
    ...(unavailable ? { unavailable } : {}),
  } satisfies ListingVersion;
}

function providerListing(
  id: string,
  versions: ManagedProviderPackage[] = [],
  entry: ManagedProviderInventoryEntry | undefined,
  recommended: string | undefined,
  catalog?: ManagedCatalogResponse,
): MarketplaceListing {
  const meta = pickMeta(versions, (item) => item.agent.version, recommended);
  return {
    ...baseListing(
      "provider",
      id,
      versions.map((item) => providerVersion(item, catalog)),
      recommended,
      entry && providerInstalled(entry),
    ),
    name: meta?.agent.name ?? id,
    description: meta?.agent.description ?? "",
    publisher: meta?.host.publisher,
    license: meta?.agent.license,
    repository: meta?.agent.repository,
    website: meta?.agent.website,
    authors: meta?.agent.authors ?? [],
  };
}

function themeListing(
  id: string,
  versions: ThemeMarketplacePackage[] = [],
  entry: ManagedThemeEntry | undefined,
  recommended: string | undefined,
  displayedThemeId: string | undefined,
): MarketplaceListing {
  const meta = pickMeta(versions, (item) => item.theme.version, recommended);
  return {
    ...baseListing(
      "theme",
      id,
      versions.map((item) => ({
        version: item.theme.version,
        minApp: item.host.compatibility.min_app_version,
        maxApp: item.host.compatibility.max_app_version,
        platforms: [],
        sha256: item.theme.distribution.sha256,
      })),
      recommended,
      entry && themeInstalled(entry, displayedThemeId),
    ),
    name: meta?.theme.name ?? entry?.name ?? id,
    description: meta?.theme.description ?? "",
    publisher: meta?.host.publisher,
    license: meta?.theme.license,
    repository: meta?.theme.repository,
    authors: [],
  };
}

function tabVersion(item: TabMarketplacePackage, catalog?: ManagedThemeCatalogResponse) {
  // The service decides what installs here; it parsed the signed entry.
  const unavailable = catalog?.unavailable_versions?.[item.tab.id]?.[item.tab.version];
  const blocked = catalog?.blocked_versions?.[item.tab.id]?.[item.tab.version];
  return {
    ...(blocked ? { blocked } : {}),
    version: item.tab.version,
    minApp: item.host.compatibility.min_app_version,
    maxApp: item.host.compatibility.max_app_version,
    platforms: Object.keys(item.tab.distribution.binary ?? {}),
    ...(unavailable ? { unavailable } : {}),
    sha256: item.tab.distribution.sha256,
    nativeCode: tabNativeCode(item),
  } satisfies ListingVersion;
}

function tabListings(sources: ListingSources): MarketplaceListing[] {
  const groups = groupTabPackages(sources.tabCatalog);
  const entries = new Map((sources.tabInventory ?? []).map((item) => [item.id, item]));
  return [...new Set([...groups.keys(), ...entries.keys()])].map((id) => {
    const versions = groups.get(id) ?? [];
    const installed = entries.get(id);
    const runtime = sources.tabSummaries?.find((item) => item.id === id);
    const recommended = sources.tabCatalog?.recommended_versions[id];
    const meta = pickMeta(versions, (item) => item.tab.version, recommended);
    return {
      ...baseListing(
        "tab",
        id,
        versions.map((item) => tabVersion(item, sources.tabCatalog)),
        recommended,
        installed
          ? {
              version: installed.version,
              active: runtime?.enablement.effective ?? false,
              enabled: runtime?.enablement.global ?? false,
              usable: !installed.error && runtime?.status === "valid",
              restartRequired: false,
              error: installed.error,
              blocked:
                installed.blocked ??
                (runtime?.status === "blocked" ? (runtime.blocked_reason ?? "Blocked") : null),
            }
          : undefined,
      ),
      name: meta?.tab.name ?? installed?.name ?? id,
      description: meta?.tab.description ?? "",
      publisher: meta?.host.publisher,
      repository: meta?.tab.repository,
      license: meta?.tab.license,
      authors: [],
      installedNativeCode: installed && runtime ? runtimeNativeCode(runtime) : null,
      pendingVersion: installed?.pending_version ?? null,
      pendingBlocked: runtime?.pending_update?.blocked_reason ?? null,
    };
  });
}

interface ListingSources {
  lspCatalog?: LspCatalog;
  lspInventory?: LspInventory;
  providerCatalog?: ManagedCatalogResponse;
  providerInventory?: ManagedProviderInventoryEntry[];
  themeCatalog?: ManagedThemeCatalogResponse;
  themeInventory?: ManagedThemeEntry[];
  displayedThemeId?: string;
  tabCatalog?: ManagedThemeCatalogResponse;
  tabInventory?: ManagedTabInventoryEntry[];
  tabSummaries?: PluginTabSummary[];
}

/** One list across kinds: every catalog package plus anything installed but no longer listed. */
export function buildListings(sources: ListingSources): MarketplaceListing[] {
  const providerGroups = new Map(
    groupPackages(providerCatalogPackages(sources.providerCatalog?.index)).map((group) => [
      group[0].agent.id,
      group,
    ]),
  );
  const providerEntries = new Map((sources.providerInventory ?? []).map((e) => [e.id, e]));
  const themeGroups = new Map(
    groupThemePackages(sources.themeCatalog).map((group) => [group[0].theme.id, group]),
  );
  const themeEntries = new Map((sources.themeInventory ?? []).map((e) => [e.id, e]));
  const providerIds = new Set([...providerGroups.keys(), ...providerEntries.keys()]);
  const themeIds = new Set([...themeGroups.keys(), ...themeEntries.keys()]);
  const members = [
    ...tabListings(sources),
    ...lspListings(sources.lspCatalog, sources.lspInventory),
    ...[...providerIds].map((id) =>
      providerListing(
        id,
        providerGroups.get(id),
        providerEntries.get(id),
        sources.providerCatalog?.recommended_versions?.[id],
        sources.providerCatalog,
      ),
    ),
    ...[...themeIds].map((id) =>
      themeListing(
        id,
        themeGroups.get(id),
        themeEntries.get(id),
        sources.themeCatalog?.recommended_versions[id],
        sources.displayedThemeId,
      ),
    ),
  ];
  const plugins = pluginListings(pluginCatalogs(sources), members);
  const partOf = new Map(
    plugins.flatMap((plugin) =>
      plugin.versions.flatMap((entry) =>
        (entry.members ?? []).map((member) => [
          listingKey(member.kind, member.id),
          { id: plugin.id, name: plugin.name },
        ]),
      ),
    ),
  );
  // A provider inventory row without a revision is a failed install, not an installation.
  return [
    ...members.map((listing) => {
      const plugin = partOf.get(listing.key);
      return plugin ? { ...listing, partOf: plugin } : listing;
    }),
    ...plugins,
  ]
    .filter((listing) => listing.inCatalog || listing.installed)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every signed package list that can carry plugin entries (schema 2). */
function pluginCatalogs(sources: ListingSources): (readonly unknown[] | undefined)[] {
  const provider = sources.providerCatalog?.index?.signed;
  return [
    provider?.schema_version === 2 ? provider.packages : undefined,
    sources.themeCatalog?.index?.signed.packages,
    sources.tabCatalog?.index?.signed.packages,
    sources.lspCatalog?.index?.signed.packages,
  ];
}

/**
 * What the showcase leads with, honestly ordered: pending updates, then what
 * the user has not installed yet. Never an invented "featured" pick.
 */
export function spotlightListings(listings: MarketplaceListing[], limit = 5): MarketplaceListing[] {
  const updates = listings.filter((listing) => listing.update);
  const fresh = listings.filter((listing) => listing.inCatalog && !listing.installed);
  return [...updates, ...fresh].slice(0, limit);
}

/** Every search term must appear in the name, id, description, publisher or a kind. */
export function matchesListing(listing: MarketplaceListing, terms: readonly string[]): boolean {
  return matchesSidebarFilter(terms, [
    listing.name,
    listing.id,
    listing.description,
    listing.publisher,
    listing.kind,
    ...listing.contributes,
  ]);
}
