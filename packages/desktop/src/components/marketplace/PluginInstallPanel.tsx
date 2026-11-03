import { Ban, Check, Loader2, Power, type LucideIcon } from "lucide-react";
import { BLOCKED_COPY } from "@/components/plugin-tabs/plugin-tab-access";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { versionProblem, type VersionProblem } from "@/lib/marketplace-listing-base";
import { compareVersions } from "@/lib/marketplace-versions";
import { useMarketplaceState } from "./MarketplaceContext";
import { TabActivation } from "./TabActivation";
import { TabInstallNote } from "./TabInstallNote";
import { usePluginActions } from "./usePluginActions";

type ListingVersion = MarketplaceListing["versions"][number];

/** A button that installs or moves to `version`. */
export interface Offer {
  state: "install" | "update" | "change";
  version: string;
}

/** Not an offer: a disabled button that says where the chosen version stands. */
export interface Settled {
  state: "settled";
  label: string;
  icon: LucideIcon | null;
}

export const LABELS = { install: "Install", update: "Update to", change: "Change to" } as const;

export const SETTLED = {
  runtime: { state: "settled", label: "Needs Node.js on this machine", icon: Ban },
  policy: { state: "settled", label: "Installation policy unavailable", icon: Ban },
  compatibility: { state: "settled", label: "Incompatible with this Cadencr", icon: Ban },
  installed: { state: "settled", label: "Installed", icon: Check },
  unavailable: { state: "settled", label: "Not available on this platform", icon: Ban },
  outdated: { state: "settled", label: "Needs a newer Cadencr", icon: Ban },
  blocked: { state: "settled", label: BLOCKED_COPY.title, icon: Ban },
  choose: { state: "settled", label: "Choose a version", icon: null },
  incomplete: { state: "settled", label: "Catalog incomplete", icon: Ban },
} as const satisfies Record<string, Settled>;

const PROBLEM_NOTES: Record<VersionProblem, string> = {
  runtime: " · needs Node.js",
  policy: " · installation policy unavailable",
  compatibility: " · incompatible Cadencr version",
  outdated: " · needs a newer Cadencr",
  unavailable: " · not for this platform",
  blocked: " · blocked",
  incomplete: " · catalog incomplete",
};

/** The version picker's suffix for the same problems. */
function versionNote(entry: ListingVersion): string {
  const problem = versionProblem(entry);
  return problem ? PROBLEM_NOTES[problem] : "";
}

/** What the primary button offers for the chosen exact version. */
function primaryAction(listing: MarketplaceListing, version: string): Offer | Settled {
  const externalLsp = listing.kind === "lsp" && listing.installed && !listing.installed.managed;
  const installed = externalLsp ? undefined : listing.installed?.version;
  if (installed && version === installed) return SETTLED.installed;
  const entry = listing.versions.find((item) => item.version === version);
  if (entry?.unavailable === "protocol") return SETTLED.outdated;
  if (!entry) return listing.availableHere ? SETTLED.choose : SETTLED.unavailable;
  const problem = versionProblem(entry);
  if (problem) return SETTLED[problem];
  if (!listing.availableHere) return SETTLED.unavailable;
  // Already downloaded and verified: what is left is the user's review.
  if (version === listing.pendingVersion)
    return { state: "settled", label: `Update ${version} staged`, icon: null };
  if (!installed) return { state: "install", version };
  const newer = (compareVersions(version, installed) ?? 0) > 0;
  return { state: newer ? "update" : "change", version };
}

export function PluginInstallPanel({
  listing,
  version,
  onVersionChange,
}: {
  listing: MarketplaceListing;
  version: string;
  onVersionChange: (version: string) => void;
}): React.JSX.Element {
  const actions = usePluginActions();
  const action = primaryAction(listing, version);
  const pending = actions.pending(listing);
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {action.state === "settled" ? (
          <SettledAction action={action} />
        ) : (
          <Button
            className="min-w-36 rounded-lg"
            disabled={!actions.canInstall(listing) || actions.busy(listing)}
            onClick={() => actions.install(listing, action.version)}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {pending
              ? "Applying…"
              : `${listing.kind === "lsp" && listing.installed && !listing.installed.managed ? "Install managed version" : LABELS[action.state]} ${action.version}`}
          </Button>
        )}
        <KindAction listing={listing} />
        <VersionSelect listing={listing} version={version} onVersionChange={onVersionChange} />
      </div>
      <TabInstallNote listing={listing} version={version} />
      <p className="text-xs text-muted-foreground">
        {listing.recommended
          ? `Recommended for this machine: ${listing.recommended}.`
          : listing.availableHere
            ? "No compatible version is recommended for this machine — choose one explicitly."
            : ""}{" "}
        {listing.installed ? "Nothing changes until you choose another version." : ""}
        {!actions.canInstall(listing) && listing.inCatalog
          ? " Installing needs a current verified catalog and a loaded inventory."
          : ""}
      </p>
    </div>
  );
}

/** Every exact version on offer, with what it is to this machine. */
export function VersionSelect({
  listing,
  version,
  onVersionChange,
}: {
  listing: MarketplaceListing;
  version: string;
  onVersionChange: (version: string) => void;
}): React.JSX.Element {
  const installedVersion = listing.installed?.version;
  const orphan =
    !!installedVersion && !listing.versions.some((v) => v.version === installedVersion);
  return (
    <Select value={version} onValueChange={onVersionChange}>
      <SelectTrigger
        aria-label="Exact version"
        className="order-last w-full text-xs sm:order-none sm:w-auto sm:min-w-40"
      >
        <SelectValue placeholder="Choose a version" />
      </SelectTrigger>
      <SelectContent>
        {orphan && (
          <SelectItem value={installedVersion} className="text-xs">
            <span className="font-mono">{installedVersion}</span> · installed, not in catalog
          </SelectItem>
        )}
        {listing.versions.map((entry) => (
          <SelectItem key={entry.version} value={entry.version} className="text-xs">
            <span className="font-mono">{entry.version}</span>
            {entry.version === listing.recommended ? " · recommended" : ""}
            {entry.version === installedVersion ? " · installed" : ""}
            {entry.version === listing.pendingVersion ? " · awaiting review" : ""}
            {versionNote(entry)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A settled state is not an offer: never a filled primary. */
export function SettledAction({ action }: { action: Settled }): React.JSX.Element {
  const Icon = action.icon;
  return (
    <Button variant="secondary" disabled className="min-w-36 rounded-lg">
      {Icon && <Icon aria-hidden="true" />}
      {action.label}
    </Button>
  );
}

/**
 * What an installed single kind does next. Theme: put it on screen. Provider:
 * whether it starts with Cadencr. Tab: enable it (asking consent first).
 */
export function KindAction({ listing }: { listing: MarketplaceListing }): React.JSX.Element | null {
  const { providers, themes, themeLoading } = useMarketplaceState();
  const installed = listing.installed;
  if (!installed || listing.kind === "plugin" || listing.kind === "lsp") return null;
  if (listing.kind === "tab") return <TabActivation id={listing.id} />;
  if (listing.kind === "theme")
    return (
      <Button
        variant="outline"
        className="rounded-lg"
        disabled={
          installed.active || !installed.usable || themeLoading || themes.mutation.isPending
        }
        onClick={() => themes.mutation.mutate({ kind: "apply", id: listing.id })}
      >
        {installed.active ? "In use" : "Use this theme"}
      </Button>
    );
  return (
    <Button
      variant="outline"
      className="rounded-lg"
      disabled={providers.mutation.isPending}
      onClick={() =>
        providers.mutation.mutate({ kind: "enabled", id: listing.id, enabled: !installed.enabled })
      }
    >
      <Power aria-hidden="true" />
      {installed.enabled ? "Disable" : "Enable"}
    </Button>
  );
}
