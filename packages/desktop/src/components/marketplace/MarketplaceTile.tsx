import { memo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { displayVersion, type MarketplaceListing } from "@/lib/marketplace-listings";
import { cn } from "@/lib/utils";
import { KINDS, type MarketplaceKind } from "./kinds";
import { PluginArt } from "./PluginArt";
import { describe, KindChips, PluginStateBadge } from "./PluginBits";

/** A tile's frame: artwork, then name and badge, a meta line, a description and kind chips. */
export function TileFrame({
  kind,
  id,
  name,
  badge,
  meta,
  description,
  chips,
  art,
}: {
  kind: MarketplaceKind;
  id: string;
  name: string;
  badge: ReactNode;
  meta: ReactNode;
  description: string;
  chips: readonly MarketplaceKind[];
  art: ReactNode;
}): React.JSX.Element {
  return (
    <Link
      to="/marketplace/$kind/$id"
      params={{ kind, id }}
      className={cn(
        "mp-tile group flex h-full flex-col overflow-hidden rounded-lg",
        KINDS[kind].tone,
      )}
    >
      <div className="mp-tile-art">{art}</div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold leading-5">{name}</h3>
          {badge}
        </div>
        <p className="truncate text-[11px] text-muted-foreground">{meta}</p>
        <p className="line-clamp-2 text-[12.5px] leading-[1.45] text-muted-foreground">
          {description}
        </p>
        <div className="mt-auto pt-1.5">
          <KindChips kinds={chips} />
        </div>
      </div>
    </Link>
  );
}

/** A catalog entry: its artwork first, then name, state, publisher and what it adds. */
export const MarketplaceTile = memo(function MarketplaceTile({
  listing,
}: {
  listing: MarketplaceListing;
}): React.JSX.Element {
  const version = displayVersion(listing);
  return (
    <TileFrame
      kind={listing.kind}
      id={listing.id}
      name={listing.name}
      badge={<PluginStateBadge listing={listing} />}
      meta={
        <>
          {listing.publisher}
          {listing.publisher && version && " · "}
          {version && <span className="font-mono text-[10.5px]">v{version}</span>}
        </>
      }
      description={describe(listing)}
      chips={listing.contributes}
      art={<PluginArt listing={listing} variant="tile" />}
    />
  );
});
