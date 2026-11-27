import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Loader2 } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import { blockedCopy } from "@/components/plugin-tabs/plugin-tab-access";
import { Button } from "@/components/ui/button";
import { downloadableUpdate, type MarketplaceListing } from "@/lib/marketplace-listings";
import { cn } from "@/lib/utils";
import { marketplaceError } from "@/lib/marketplace";
import { KINDS } from "./kinds";
import { useMarketplaceState } from "./MarketplaceContext";
import { LibraryEmpty } from "./MarketplaceLibraryEmpty";
import { formatAgo } from "@/lib/date-utils";
import { formatDay, KindChips, PluginMark, PluginStateBadge } from "./PluginBits";
import { memberLabel, pluginRunError, usePluginActions } from "./usePluginActions";

/** What a row says about the installation, in the order a user scans it. */
function InstalledFacts({ listing }: { listing: MarketplaceListing }): React.JSX.Element | null {
  const { t } = useUiTranslation();
  const installed = listing.installed;
  if (!installed) return null;
  const facts: string[] = [];
  if (listing.partOf)
    facts.push(
      t("marketplace.marketplaceLibrary.partOf", "Part of {{plugin}}", {
        plugin: listing.partOf.name,
      }),
    );
  if (listing.kind === "plugin") {
    const count = listing.members?.length ?? 0;
    facts.push(
      t("marketplace.marketplaceLibrary.componentCount", "{{count}} components", {
        count,
        defaultValue_zero: "{{count}} components",
        defaultValue_one: "{{count}} component",
      }),
    );
  } else if (listing.kind === "provider")
    facts.push(
      installed.enabled
        ? t("marketplace.marketplaceLibrary.startsWithCadencr", "Starts with Cadencr")
        : t("marketplace.marketplaceLibrary.disabled", "Disabled"),
    );
  else if (listing.kind === "tab")
    facts.push(
      installed.enabled
        ? t("marketplace.marketplaceLibrary.enabledGlobally", "Enabled globally")
        : t("marketplace.marketplaceLibrary.disabledGlobally", "Disabled globally"),
    );
  else if (listing.kind === "lsp")
    facts.push(t("marketplace.marketplaceLibrary.matchingFiles", "Available to matching files"));
  else if (installed.selected && !installed.active)
    facts.push(t("marketplace.marketplaceLibrary.savedTheme", "Saved in a theme slot"));
  const installedOn = formatDay(installed.installedAt);
  if (installedOn)
    facts.push(
      t("marketplace.marketplaceLibrary.installedOn", "Installed {{date}}", { date: installedOn }),
    );
  if (installed.updatedAt && installed.updatedAt !== installed.installedAt)
    facts.push(
      t("marketplace.marketplaceLibrary.updatedAgo", "Updated {{date}}", {
        date: formatAgo(installed.updatedAt),
      }),
    );
  if (!listing.inCatalog)
    facts.push(t("marketplace.marketplaceLibrary.outOfCatalog", "No longer in the catalog"));
  return (
    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
      <span className="font-mono text-[10.5px]">
        {installed.version ?? t("marketplace.pluginBits.noRevision", "No revision")}
        {listing.update && <span className="text-primary"> → {listing.update}</span>}
      </span>
      {facts.map((fact) => ` · ${fact}`).join("")}
    </p>
  );
}

type Actions = ReturnType<typeof usePluginActions>;

/** A plugin update walking its members from this row: which one is in flight, or stopped it. */
function PluginRunLine({ listingKey }: { listingKey: string }): React.JSX.Element | null {
  const { t } = useUiTranslation();
  const { pluginRun } = useMarketplaceState();
  if (pluginRun?.key !== listingKey) return null;
  const member = memberLabel(pluginRun.member, t);
  return pluginRun.status === "running" ? (
    <p role="status" className="mt-0.5 truncate text-[11px] text-muted-foreground">
      {t(
        "marketplace.pluginRun.installingMemberProgress",
        "Installing {{member}} ({{step}} of {{total}})…",
        { member, step: pluginRun.step, total: pluginRun.total },
      )}
    </p>
  ) : (
    <p role="alert" className="mt-0.5 truncate text-[11px] text-destructive">
      {t("marketplace.pluginRun.stoppedAt", "Stopped at {{member}}: {{message}}", {
        member,
        message: pluginRunError(pluginRun.error, t),
      })}
    </p>
  );
}

const LibraryRow = memo(function LibraryRow({
  listing,
  actions,
}: {
  listing: MarketplaceListing;
  actions: Actions;
}): React.JSX.Element {
  const { t } = useUiTranslation();
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
            {t("marketplace.activity.labeledError", "{{label}}: {{message}}", {
              label: blockedCopy(t).title,
              message: listing.installed.blocked,
            })}
          </p>
        )}
        {listing.installed?.error && (
          <p role="alert" className="mt-0.5 truncate text-[11px] text-destructive">
            {listing.installed.error}
          </p>
        )}
        {listing.kind === "plugin" && <PluginRunLine listingKey={listing.key} />}
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
          {pending
            ? t("marketplace.marketplaceLibrary.updating", "Updating…")
            : t("marketplace.pluginInstallPanel.updateVersion", "Update to {{version}}", {
                version: update,
              })}
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

function UpdateAllBar({
  listings,
  actions,
}: {
  listings: MarketplaceListing[];
  actions: Actions;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const { updatingAll, setUpdatingAll } = useMarketplaceState();
  const [stopped, setStopped] = useState<{ error: unknown } | null>(null);
  const busy = updatingAll || listings.some((listing) => actions.busy(listing));
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        {t(
          "marketplace.marketplaceLibrary.updateCount",
          "{{count}} updates available. Updates are never automatic: each installs the exact recommended version shown.",
          {
            count: listings.length,
            defaultValue_zero:
              "{{count}} updates available. Updates are never automatic: each installs the exact recommended version shown.",
            defaultValue_one:
              "{{count}} update available. Updates are never automatic: each installs the exact recommended version shown.",
          },
        )}
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
              .catch((error: unknown) => setStopped({ error }))
              .finally(() => setUpdatingAll(false));
          }}
        >
          {updatingAll && <Loader2 aria-hidden="true" className="animate-spin" />}
          {updatingAll
            ? t("marketplace.marketplaceLibrary.updating", "Updating…")
            : t("marketplace.marketplaceLibrary.updateAll", "Update all {{count}}", {
                count: listings.length,
              })}
        </Button>
      )}
      {stopped && (
        <p role="alert" className="w-full text-xs text-destructive">
          {t("marketplace.marketplaceLibrary.updateAllStopped", "Update all stopped: {{message}}", {
            message:
              marketplaceError(stopped.error, t) ??
              t("marketplace.marketplaceLibrary.updateFailed", "An update failed."),
          })}
        </p>
      )}
    </div>
  );
}
