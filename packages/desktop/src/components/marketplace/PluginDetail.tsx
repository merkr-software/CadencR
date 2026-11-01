import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, PackageX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import {
  offeredVersion,
  type MarketplaceListing,
  type PluginKind,
} from "@/lib/marketplace-listings";
import { BLOCKED_COPY, reasonSentence } from "@/components/plugin-tabs/plugin-tab-access";
import { cn } from "@/lib/utils";
import { KINDS, type MarketplaceKind } from "./kinds";
import { useMarketplaceState } from "./MarketplaceContext";
import { MarketplaceActivity } from "./MarketplaceActivity";
import { MarketplaceEmpty } from "./MarketplaceStates";
import { PluginArt } from "./PluginArt";
import { byline, describe, KindChips, PluginMark, PluginStateBadge } from "./PluginBits";
import {
  FactsSection,
  HistorySection,
  TrustSection,
  VersionsSection,
} from "./PluginDetailSections";
import { PluginInstallPanel } from "./PluginInstallPanel";
import { PluginManage } from "./PluginManage";

/** One plugin's page: what it is, how it looks in Cadencr, every version, and its record here. */
export function PluginDetail({ kind, id }: { kind: PluginKind; id: string }): React.JSX.Element {
  const state = useMarketplaceState();
  const listing = state.listings.find((item) => item.kind === kind && item.id === id);
  return (
    <DetailPage kind={kind} name={listing?.name ?? id}>
      <MarketplaceActivity />
      {listing ? (
        <PluginDetailBody key={listing.key} listing={listing} />
      ) : state.loading ? (
        <Skeleton
          role="status"
          aria-label="Loading plugin"
          className="h-[320px] w-full rounded-xl"
        />
      ) : (
        <MarketplaceEmpty
          icon={PackageX}
          title="This plugin is not in the catalog or installed"
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/marketplace">Back to the marketplace</Link>
            </Button>
          }
        />
      )}
    </DetailPage>
  );
}

/** A detail page: its header, then one scrolling, centered column. */
export function DetailPage({
  kind,
  name,
  className,
  children,
}: {
  kind: MarketplaceKind;
  name: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div data-feature-chrome="standard" className="flex h-full flex-col bg-background">
      <DetailHeader kind={kind} name={name} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto w-full max-w-[1180px] space-y-6 px-5 py-6", className)}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function DetailHeader({
  kind,
  name,
}: {
  kind: MarketplaceKind;
  name: string;
}): React.JSX.Element {
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  return (
    <header className="titlebar-drag flex min-h-14 shrink-0 items-center gap-2 border-b border-border/60 px-5">
      <SidebarCollapsedChrome visible={collapsed} onExpand={() => setCollapsed(false)} />
      <Button asChild variant="ghost" size="sm" className="h-7 gap-1.5 px-2">
        <Link to="/marketplace">
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Marketplace
        </Link>
      </Button>
      <span aria-hidden="true" className="text-muted-foreground/60">
        /
      </span>
      <Link
        to="/marketplace"
        search={{ kind }}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        {KINDS[kind].plural}
      </Link>
      <span aria-hidden="true" className="text-muted-foreground/60">
        /
      </span>
      <span className="min-w-0 truncate text-sm font-medium">{name}</span>
    </header>
  );
}

function PluginDetailBody({ listing }: { listing: MarketplaceListing }): React.JSX.Element {
  const { providers } = useMarketplaceState();
  const [chosen, setChosen] = useState<string | null>(null);
  // Recomputed until the user picks: an inventory that loads late must win over
  // the recommendation, so an installed newer revision is never offered a downgrade.
  const version = chosen ?? offeredVersion(listing);
  const providerEntry =
    listing.kind === "provider"
      ? providers.inventoryQuery.data?.providers.find((entry) => entry.id === listing.id)
      : undefined;
  return (
    <div className={cn("space-y-10", KINDS[listing.kind].tone)}>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-4">
            <PluginMark listing={listing} size={64} />
            <div className="min-w-0 space-y-1">
              <h1 className="text-[26px] font-bold leading-tight tracking-[-0.015em]">
                {listing.name}
              </h1>
              <p className="truncate text-xs text-muted-foreground">{byline(listing)}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <KindChips kinds={listing.contributes} />
            <PluginStateBadge listing={listing} />
          </div>
          <p className="max-w-[62ch] text-[14.5px] leading-[1.6] text-foreground/90">
            {describe(listing)}
          </p>
          {listing.installed?.blocked && <BlockedReason reason={listing.installed.blocked} />}
          {listing.installed?.error && (
            <p role="alert" className="text-xs text-destructive">
              {listing.installed.error}
            </p>
          )}
          <PluginInstallPanel listing={listing} version={version} onVersionChange={setChosen} />
        </div>
        <DetailStage listing={listing} version={version} />
      </section>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className={cn("grid min-w-0 content-start gap-10", providerEntry && "xl:grid-cols-2")}>
          <VersionsSection listing={listing} version={version} onVersionChange={setChosen} />
          {providerEntry && <HistorySection entry={providerEntry} />}
        </div>
        <aside className="min-w-0 space-y-8">
          <FactsSection listing={listing} />
          <TrustSection listing={listing} version={version} />
          <PluginManage listing={listing} />
        </aside>
      </div>
    </div>
  );
}

/** Revoked through Cadencr's signed blocklist: what is left is removal or another version. */
function BlockedReason({ reason }: { reason: string }): React.JSX.Element {
  return (
    <p role="alert" className="max-w-[62ch] text-xs text-destructive">
      <span className="font-medium">{BLOCKED_COPY.title}: </span>
      {reasonSentence(reason)} {BLOCKED_COPY.effect} {BLOCKED_COPY.remedy}
    </p>
  );
}

function DetailStage({
  listing,
  version,
}: {
  listing: MarketplaceListing;
  version: string;
}): React.JSX.Element {
  return (
    <div className="mp-spotlight relative aspect-[16/10] overflow-hidden rounded-xl lg:aspect-auto lg:min-h-[240px]">
      <PluginArt listing={listing} variant="detail" version={version || undefined} />
    </div>
  );
}
