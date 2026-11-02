import { format } from "date-fns";
import {
  ArrowUpCircle,
  Ban,
  Check,
  CircleAlert,
  CircleDashed,
  RotateCw,
  ShieldAlert,
} from "lucide-react";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { Badge } from "@/components/ui/badge";
import { ProviderIconGraphic, useProviderMetadata } from "@/lib/provider-icons";
import { cn } from "@/lib/utils";
import { KINDS, type MarketplaceKind } from "./kinds";

export function formatDay(iso?: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format(date, "MMM d, yyyy");
}

/** Description with the one honest fallback, shared by every surface. */
export function describe(listing: MarketplaceListing): string {
  return listing.description || "No description in the catalog.";
}

export function byline(listing: MarketplaceListing): string {
  return listing.publisher ? `by ${listing.publisher}` : listing.id;
}

function KindChip({ kind }: { kind: MarketplaceKind }): React.JSX.Element {
  const meta = KINDS[kind];
  const Icon = meta.icon;
  return (
    <span className={cn("mp-kind-chip", meta.tone)}>
      <Icon aria-hidden="true" className="size-3" />
      {meta.label}
    </span>
  );
}

export function KindChips({ kinds }: { kinds: readonly MarketplaceKind[] }): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-1" aria-label="Adds">
      {kinds.map((kind) => (
        <KindChip key={kind} kind={kind} />
      ))}
    </span>
  );
}

export function initials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The plugin's identity mark: its own package icon once Cadencr has it (an
 * installed provider, resolved like every other provider icon), else a
 * monogram in the kind's tone. Catalog entries serve no icon before install.
 */
export function PluginMark({
  listing,
  size = 40,
}: {
  listing: MarketplaceListing;
  size?: number;
}): React.JSX.Element {
  const installedProvider = listing.kind === "provider" && !!listing.installed;
  const metadata = useProviderMetadata(installedProvider ? listing.id : null);
  return (
    <span
      aria-hidden="true"
      className={cn("mp-mark", KINDS[listing.kind].tone)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {installedProvider && metadata?.iconSrc ? (
        <ProviderIconGraphic providerId={listing.id} metadata={metadata} alt="" className="" />
      ) : (
        initials(listing.name)
      )}
    </span>
  );
}

const STATE_TONES = {
  error: "bg-destructive/12 text-destructive",
  restart: "bg-[var(--acc-yellow)]/16 text-[var(--acc-yellow)]",
  primary: "bg-primary/12 text-primary",
  muted: "bg-foreground/7 text-muted-foreground",
} as const;

interface ListingState {
  tone: string;
  icon: React.JSX.Element;
  label: string;
}

/** The one state that matters most for a listing, most actionable first. */
function stateOf(listing: MarketplaceListing): ListingState | null {
  const installed = listing.installed;
  if (installed?.blocked)
    return { tone: STATE_TONES.error, icon: <Ban aria-hidden="true" />, label: "Blocked" };
  if (installed?.error)
    return {
      tone: STATE_TONES.error,
      icon: <CircleAlert aria-hidden="true" />,
      label: "Needs attention",
    };
  if (listing.pendingVersion && listing.pendingBlocked)
    return {
      tone: STATE_TONES.error,
      icon: <Ban aria-hidden="true" />,
      label: `Update ${listing.pendingVersion} blocked`,
    };
  if (listing.pendingVersion)
    return {
      tone: STATE_TONES.restart,
      icon: <ShieldAlert aria-hidden="true" />,
      label: `Review update ${listing.pendingVersion}`,
    };
  if (installed?.restartRequired)
    return {
      tone: STATE_TONES.restart,
      icon: <RotateCw aria-hidden="true" />,
      label: "Restart to apply",
    };
  // A plugin whose members are not all in, at one release: the install panel finishes it.
  if (installed?.partial)
    return {
      tone: STATE_TONES.restart,
      icon: <CircleDashed aria-hidden="true" />,
      label: "Partly installed",
    };
  if (listing.update)
    return {
      tone: STATE_TONES.primary,
      icon: <ArrowUpCircle aria-hidden="true" />,
      label: `Update ${listing.update}`,
    };
  if (installed?.active)
    return {
      tone: STATE_TONES.primary,
      icon: <span className="size-1.5 rounded-full bg-primary" />,
      label: listing.kind === "theme" ? "In use" : "Active",
    };
  if (installed)
    return { tone: STATE_TONES.muted, icon: <Check aria-hidden="true" />, label: "Installed" };
  return null;
}

export function PluginStateBadge({
  listing,
  className,
}: {
  listing: MarketplaceListing;
  className?: string;
}): React.JSX.Element | null {
  const state = stateOf(listing);
  if (!state) return null;
  return (
    <Badge variant="ghost" className={cn("h-5 px-2 text-[11px]", state.tone, className)}>
      {state.icon}
      {state.label}
    </Badge>
  );
}
