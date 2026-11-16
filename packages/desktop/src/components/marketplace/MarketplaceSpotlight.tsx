import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { cn } from "@/lib/utils";
import { KINDS } from "./kinds";
import { PluginArt } from "./PluginArt";
import { byline, describe, KindChips, PluginMark, PluginStateBadge } from "./PluginBits";

/**
 * The showcase: one plugin at the scale it lives at in Cadencr. It leads with
 * pending updates, then what the user has not installed yet — the order is a
 * fact about the user's own setup, never an editorial pick.
 */
export function MarketplaceSpotlight({
  listings,
}: {
  listings: MarketplaceListing[];
}): React.JSX.Element | null {
  // Follow the plugin, not the slot: an install that drops it from the list
  // falls back to the first entry instead of silently showing a neighbour.
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  if (!listings.length) return null;
  const index = Math.max(
    0,
    listings.findIndex((entry) => entry.key === currentKey),
  );
  const listing = listings[index];
  const step = (delta: number) =>
    setCurrentKey(listings[(index + delta + listings.length) % listings.length].key);
  return (
    <section
      aria-label="Showcase"
      aria-roledescription="carousel"
      className={cn(
        "mp-spotlight grid overflow-hidden rounded-xl md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]",
        KINDS[listing.kind].tone,
      )}
    >
      <div key={listing.key} className="mp-spotlight-enter flex min-w-0 flex-col gap-3 p-5 md:p-6">
        <div className="flex items-center gap-3">
          <PluginMark listing={listing} size={48} />
          <div className="min-w-0">
            <h2 className="truncate text-[22px] font-bold leading-tight tracking-[-0.01em]">
              {listing.name}
            </h2>
            <p className="truncate text-xs text-muted-foreground">{byline(listing)}</p>
          </div>
        </div>
        <p className="line-clamp-3 max-w-[60ch] text-sm leading-[1.55] text-foreground/85">
          {describe(listing)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <KindChips kinds={listing.contributes} />
          <PluginStateBadge listing={listing} />
          {listing.license && (
            <span className="text-[11px] text-muted-foreground">{listing.license}</span>
          )}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
          <Button asChild className="rounded-lg px-4">
            <Link to="/marketplace/$kind/$id" params={{ kind: listing.kind, id: listing.id }}>
              {listing.update ? `Review update ${listing.update}` : "View and install"}
            </Link>
          </Button>
          {listing.update && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {listing.installed?.version} → {listing.update}
            </span>
          )}
          {listings.length > 1 && (
            <div className="ml-auto flex items-center gap-1">
              <span
                className="mr-1 font-mono text-[10.5px] tabular-nums text-muted-foreground"
                aria-live="polite"
              >
                {index + 1} / {listings.length}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous plugin"
                onClick={() => step(-1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next plugin"
                onClick={() => step(1)}
              >
                <ChevronRight />
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="relative min-h-[220px] border-t border-border/70 md:min-h-[280px] md:border-t-0 md:border-l">
        <PluginArt key={listing.key} listing={listing} variant="spotlight" />
      </div>
    </section>
  );
}
