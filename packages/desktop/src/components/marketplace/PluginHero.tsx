import { BLOCKED_COPY, reasonSentence } from "@/components/plugin-tabs/plugin-tab-access";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { PluginArt } from "./PluginArt";
import { byline, describe, KindChips, PluginMark, PluginStateBadge } from "./PluginBits";

/** A detail page's identity block: mark, name, publisher, what it adds, its state and why. */
export function DetailHero({ listing }: { listing: MarketplaceListing }): React.JSX.Element {
  return (
    <>
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
    </>
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

export function DetailStage({
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
