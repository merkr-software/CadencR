import { Code2, Loader2, PanelTop, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useThemeArt } from "@/hooks/useThemePreview";
import { marketplaceError } from "@/lib/marketplace";
import { displayVersion, type MarketplaceListing } from "@/lib/marketplace-listings";
import { pluginMembers } from "@/lib/marketplace-plugin-listings";
import { useMarketplaceState } from "./MarketplaceContext";
import { ProviderStage, ThemeStage } from "./PluginStages";

type Variant = "tile" | "spotlight" | "detail";

/**
 * A plugin at the scale it lives at in Cadencr, for every surface that shows
 * one: tiles, the showcase and the detail page. Themes not installed paint
 * from their verified preview, fetched as soon as they are shown.
 */
export function PluginArt({
  listing,
  variant,
  version = displayVersion(listing),
}: {
  listing: MarketplaceListing;
  variant: Variant;
  version?: string;
}): React.JSX.Element {
  if (listing.kind === "plugin")
    return <PluginPackageArt listing={listing} variant={variant} version={version} />;
  if (listing.kind === "lsp") return <LspArt listing={listing} />;
  if (listing.kind === "tab") return <TabArt listing={listing} />;
  if (listing.kind === "provider")
    return <ProviderStage listing={listing} compact={variant === "tile"} />;
  return <ThemeArt key={version} listing={listing} variant={variant} version={version} />;
}

/** What a plugin looks like: its most visible member (a theme, else a provider, else a tab). */
const FACE_ORDER = ["theme", "provider", "tab", "lsp"] as const;

function PluginPackageArt({
  listing,
  variant,
  version,
}: {
  listing: MarketplaceListing;
  variant: Variant;
  version?: string;
}): React.JSX.Element {
  const { listingsByKey } = useMarketplaceState();
  const members = pluginMembers(listing, version, listingsByKey);
  const face = FACE_ORDER.flatMap((kind) =>
    members.flatMap((member) => (member.ref.kind === kind && member.listing) || []),
  )[0];
  if (!face)
    return (
      <>
        <ThemeStage definition={null} />
        <div className="absolute inset-0 grid place-items-center">
          <span className="rounded-full bg-background/85 px-2.5 py-1 text-[11px] text-muted-foreground">
            No preview available
          </span>
        </div>
      </>
    );
  // Members ship in their plugin's release, so the plugin version is the member's.
  return <PluginArt listing={face} variant={variant} version={version} />;
}

function ThemeArt({
  listing,
  variant,
  version,
}: {
  listing: MarketplaceListing;
  variant: Variant;
  version?: string;
}): React.JSX.Element {
  const { themes } = useMarketplaceState();
  const art = useThemeArt(themes, listing, version);
  const error = marketplaceError(art.error);
  if (art.definition)
    return (
      <>
        <ThemeStage definition={art.definition} />
        {variant === "detail" && (
          <span className="absolute bottom-3 left-3 rounded-full bg-background/85 px-2.5 py-1 text-[11px] text-muted-foreground">
            {art.installed ? `Installed ${version}` : `Preview of ${version} — not installed`}
          </span>
        )}
      </>
    );
  return (
    <>
      <ThemeStage definition={null} />
      <div className="absolute inset-0 grid place-items-center">
        {error ? (
          <div className="flex max-w-[85%] flex-col items-center gap-2 text-center">
            {/* A failing shelf would announce one alert per tile. */}
            <span
              role={variant === "tile" ? undefined : "alert"}
              className="text-[11px] text-destructive"
            >
              {error}
            </span>
            {variant !== "tile" && (
              <Button size="sm" variant="outline" disabled={art.loading} onClick={art.retry}>
                <RotateCw aria-hidden="true" />
                Retry preview
              </Button>
            )}
          </div>
        ) : art.loading ? (
          <Loader2
            aria-label="Loading preview"
            className="size-4 animate-spin text-muted-foreground"
          />
        ) : (
          !art.canPreview && (
            <span className="rounded-full bg-background/85 px-2.5 py-1 text-[11px] text-muted-foreground">
              No preview available
            </span>
          )
        )}
      </div>
    </>
  );
}

function TabArt({ listing }: { listing: MarketplaceListing }): React.JSX.Element {
  return (
    <div
      className="mp-kind-tab flex h-full w-full flex-col bg-card p-4"
      aria-label="Custom workspace tab"
    >
      <div className="flex items-center gap-2 border-b border-border pb-2 text-xs font-medium text-[var(--mp-kind)]">
        <PanelTop className="size-3.5" aria-hidden />
        {listing.name}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <PanelTop className="size-8" aria-hidden />
        <span className="text-xs">Custom workspace tab</span>
      </div>
    </div>
  );
}

function LspArt({ listing }: { listing: MarketplaceListing }): React.JSX.Element {
  return (
    <div className="mp-kind-lsp flex h-full w-full flex-col items-center justify-center gap-3 bg-card p-4 text-[var(--mp-kind)]">
      <Code2 className="size-8" aria-hidden />
      <span className="text-sm font-medium">{listing.name}</span>
      <span className="text-xs text-muted-foreground">Completions · navigation · diagnostics</span>
    </div>
  );
}
