import { memo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, CloudOff, Loader2, PackageOpen, Search } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import { BLOCKED_COPY } from "@/components/plugin-tabs/plugin-tab-access";
import { Button } from "@/components/ui/button";
import { downloadableUpdate, type MarketplaceListing } from "@/lib/marketplace-listings";
import { cn } from "@/lib/utils";
import { marketplaceError } from "@/lib/marketplace";
import { KINDS } from "./kinds";
import { useMarketplaceState } from "./MarketplaceContext";
import { CheckCatalogButton, MarketplaceEmpty } from "./MarketplaceStates";
import { formatAgo } from "@/lib/date-utils";
import { formatDay, KindChips, PluginMark, PluginStateBadge } from "./PluginBits";
import { usePluginActions } from "./usePluginActions";

/** What a row says about the installation, in the order a user scans it. */
function InstalledFacts({ listing }: { listing: MarketplaceListing }): React.JSX.Element | null {
  const installed = listing.installed;
  if (!installed) return null;
  const facts: string[] = [];
  if (listing.kind === "provider")
    facts.push(installed.enabled ? "Starts with Cadencr" : "Disabled");
  else if (listing.kind === "tab")
    facts.push(installed.enabled ? "Enabled globally" : "Disabled globally");
  else if (installed.selected && !installed.active) facts.push("Saved in a theme slot");
  const installedOn = formatDay(installed.installedAt);
  if (installedOn) facts.push(`Installed ${installedOn}`);
  if (installed.updatedAt && installed.updatedAt !== installed.installedAt)
    facts.push(`Updated ${formatAgo(installed.updatedAt)}`);
  if (!listing.inCatalog) facts.push("No longer in the catalog");
  return (
    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
      <span className="font-mono text-[10.5px]">
        {installed.version ?? "No revision"}
        {listing.update && <span className="text-primary"> → {listing.update}</span>}
      </span>
      {facts.map((fact) => ` · ${fact}`).join("")}
    </p>
  );
}

type Actions = ReturnType<typeof usePluginActions>;

const LibraryRow = memo(function LibraryRow({
  listing,
  actions,
}: {
  listing: MarketplaceListing;
  actions: Actions;
}): React.JSX.Element {
  const pending = actions.pending(listing);
  const update = downloadableUpdate(listing);
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border/70 px-4 py-3 last:border-b-0",
        KINDS[listing.kind].tone,
      )}
    >
      <PluginMark listing={listing} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/marketplace/$kind/$id"
            params={{ kind: listing.kind, id: listing.id }}
            className="truncate text-[13.5px] font-semibold hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {listing.name}
          </Link>
          <KindChips kinds={listing.contributes} />
        </div>
        <InstalledFacts listing={listing} />
        {listing.installed?.blocked && (
          <p role="alert" className="mt-0.5 truncate text-[11px] text-destructive">
            {BLOCKED_COPY.title}: {listing.installed.blocked}
          </p>
        )}
        {listing.installed?.error && (
          <p role="alert" className="mt-0.5 truncate text-[11px] text-destructive">
            {listing.installed.error}
          </p>
        )}
      </div>
      {/* The update button already says it; keep the badge for every other state. */}
      {(!update ||
        listing.installed?.restartRequired ||
        listing.installed?.error ||
        listing.installed?.blocked) && (
        <PluginStateBadge listing={listing} className="hidden sm:inline-flex" />
      )}
      {update && (
        <Button
          size="sm"
          disabled={!actions.canInstall(listing) || actions.busy(listing)}
          onClick={() => actions.install(listing, update)}
        >
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {pending ? "Updating…" : `Update to ${update}`}
        </Button>
      )}
      {/* Pointer shortcut only: the name link above is the keyboard stop. */}
      <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
        <Link
          to="/marketplace/$kind/$id"
          params={{ kind: listing.kind, id: listing.id }}
          tabIndex={-1}
          aria-hidden="true"
        >
          <ChevronRight />
        </Link>
      </Button>
    </div>
  );
});

/** Installed and Updates: one dense, virtualized list of what is on this machine. */
export function MarketplaceLibrary({
  view,
  listings,
  scrollParent,
  publishedAt,
  refreshing,
  onRefresh,
  onDiscover,
}: {
  view: "installed" | "updates";
  listings: MarketplaceListing[];
  scrollParent: HTMLElement | null;
  publishedAt?: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onDiscover: () => void;
}): React.JSX.Element {
  const actions = usePluginActions();
  if (!listings.length)
    return (
      <LibraryEmpty
        view={view}
        publishedAt={publishedAt}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onDiscover={onDiscover}
      />
    );
  return (
    <div className="space-y-3">
      {view === "updates" && <UpdateAllBar listings={listings} actions={actions} />}
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
        {scrollParent && (
          <Virtuoso
            data={listings}
            customScrollParent={scrollParent}
            computeItemKey={(_, listing) => listing.key}
            itemContent={(_, listing) => <LibraryRow listing={listing} actions={actions} />}
          />
        )}
      </div>
    </div>
  );
}

/** Why the Installed or Updates list is empty — never "up to date" when that is unknown. */
function LibraryEmpty({
  view,
  publishedAt,
  refreshing,
  onRefresh,
  onDiscover,
}: {
  view: "installed" | "updates";
  publishedAt?: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onDiscover: () => void;
}): React.JSX.Element {
  const state = useMarketplaceState();
  const hasUnfilteredResults = state.listings.some((listing) =>
    view === "updates" ? !!listing.update : !!listing.installed,
  );
  const inventoryUnavailable =
    state.providers.inventoryQuery.isError ||
    state.themes.inventory.isError ||
    state.tabs.inventory.isError ||
    state.tabs.summaries.isError;
  const updatesUnknown =
    inventoryUnavailable ||
    !state.catalogUsable.provider ||
    !state.catalogUsable.theme ||
    !state.catalogUsable.tab ||
    state.providers.catalogQuery.isError ||
    state.themes.catalog.isError ||
    state.tabs.catalog.isError;
  if (hasUnfilteredResults)
    return (
      <MarketplaceEmpty
        icon={Search}
        title={
          view === "updates"
            ? "No updates match your search"
            : "No installed plugins match your search"
        }
        detail="Try another search or clear it to see all results."
      />
    );
  if (view === "updates" && state.catalogMissing && !inventoryUnavailable)
    return (
      <MarketplaceEmpty
        icon={CloudOff}
        title="Updates aren't available in this build"
        detail="This build isn't connected to a plugin catalog, so there is nothing to check installed plugins against."
      />
    );
  if (view === "updates" ? updatesUnknown : inventoryUnavailable)
    return (
      <MarketplaceEmpty
        icon={CloudOff}
        title={
          view === "updates"
            ? "Updates could not be determined"
            : "Installed plugins could not be loaded"
        }
        detail="Check the notices above and try again. Installed plugins remain manageable when their inventory is available."
        action={
          !inventoryUnavailable && (
            <CheckCatalogButton refreshing={refreshing} onRefresh={onRefresh} label="Try again" />
          )
        }
      />
    );
  return view === "updates" ? (
    <MarketplaceEmpty
      icon={PackageOpen}
      title="Everything is up to date"
      detail={`Updates are never automatic: each one installs the exact version shown.${publishedAt ? ` Catalog published ${formatAgo(publishedAt)}.` : ""}`}
      action={<CheckCatalogButton refreshing={refreshing} onRefresh={onRefresh} />}
    />
  ) : (
    <MarketplaceEmpty
      icon={PackageOpen}
      title="Nothing installed from the marketplace yet"
      detail="Themes, providers and custom tabs you install show up here, with their version and history."
      action={
        <Button size="sm" onClick={onDiscover}>
          Discover plugins
        </Button>
      }
    />
  );
}

function UpdateAllBar({
  listings,
  actions,
}: {
  listings: MarketplaceListing[];
  actions: Actions;
}): React.JSX.Element {
  const { updatingAll, setUpdatingAll } = useMarketplaceState();
  const [stopped, setStopped] = useState<string | null>(null);
  const busy = updatingAll || listings.some((listing) => actions.busy(listing));
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        {listings.length} update{listings.length === 1 ? "" : "s"} available. Updates are never
        automatic: each installs the exact recommended version shown.
      </p>
      {listings.length > 1 && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !listings.every((listing) => actions.canInstall(listing))}
          onClick={() => {
            setStopped(null);
            setUpdatingAll(true);
            actions
              .updateAll(listings)
              .catch((error: unknown) => setStopped(marketplaceError(error) ?? "An update failed."))
              .finally(() => setUpdatingAll(false));
          }}
        >
          {updatingAll && <Loader2 aria-hidden="true" className="animate-spin" />}
          {updatingAll ? "Updating…" : `Update all ${listings.length}`}
        </Button>
      )}
      {stopped && (
        <p role="alert" className="w-full text-xs text-destructive">
          Update all stopped: {stopped}
        </p>
      )}
    </div>
  );
}
