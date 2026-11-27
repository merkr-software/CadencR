import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { Ban, Check, Loader2, Power, type LucideIcon } from "lucide-react";
import { blockedCopy } from "@/components/plugin-tabs/plugin-tab-access";
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
  label: (t: UiTranslator) => string;
  icon: LucideIcon | null;
}

export const OFFER_LABELS: Record<Offer["state"], (t: UiTranslator, version: string) => string> = {
  install: (t, version) =>
    t("marketplace.pluginInstallPanel.installVersion", "Install {{version}}", { version }),
  update: (t, version) =>
    t("marketplace.pluginInstallPanel.updateVersion", "Update to {{version}}", { version }),
  change: (t, version) =>
    t("marketplace.pluginInstallPanel.changeVersion", "Change to {{version}}", { version }),
};

export const SETTLED = {
  operating_system: {
    state: "settled",
    label: (t) =>
      t("marketplace.pluginInstallPanel.settled.operatingSystem", "Needs a newer macOS version"),
    icon: Ban,
  },
  runtime: {
    state: "settled",
    label: (t) =>
      t("marketplace.pluginInstallPanel.settled.runtime", "Needs Node.js on this machine"),
    icon: Ban,
  },
  policy: {
    state: "settled",
    label: (t) =>
      t("marketplace.pluginInstallPanel.settled.policy", "Installation policy unavailable"),
    icon: Ban,
  },
  compatibility: {
    state: "settled",
    label: (t) =>
      t("marketplace.pluginInstallPanel.settled.compatibility", "Incompatible with this Cadencr"),
    icon: Ban,
  },
  installed: {
    state: "settled",
    label: (t) => t("marketplace.pluginInstallPanel.settled.installed", "Installed"),
    icon: Check,
  },
  unavailable: {
    state: "settled",
    label: (t) =>
      t("marketplace.pluginInstallPanel.settled.unavailable", "Not available on this platform"),
    icon: Ban,
  },
  outdated: {
    state: "settled",
    label: (t) => t("marketplace.pluginInstallPanel.settled.outdated", "Needs a newer Cadencr"),
    icon: Ban,
  },
  blocked: { state: "settled", label: (t: UiTranslator) => blockedCopy(t).title, icon: Ban },
  choose: {
    state: "settled",
    label: (t) => t("marketplace.pluginInstallPanel.chooseAVersion", "Choose a version"),
    icon: null,
  },
  incomplete: {
    state: "settled",
    label: (t) => t("marketplace.pluginInstallPanel.settled.incomplete", "Catalog incomplete"),
    icon: Ban,
  },
} as const satisfies Record<string, Settled>;

const PROBLEM_NOTES: Record<VersionProblem, (t: UiTranslator) => string> = {
  operating_system: (t) =>
    t("marketplace.pluginInstallPanel.note.operatingSystem", "needs a newer macOS version"),
  runtime: (t) => t("marketplace.pluginInstallPanel.note.runtime", "needs Node.js"),
  policy: (t) => t("marketplace.pluginInstallPanel.note.policy", "installation policy unavailable"),
  compatibility: (t) =>
    t("marketplace.pluginInstallPanel.note.compatibility", "incompatible Cadencr version"),
  outdated: (t) => t("marketplace.pluginInstallPanel.note.outdated", "needs a newer Cadencr"),
  unavailable: (t) => t("marketplace.pluginInstallPanel.note.unavailable", "not for this platform"),
  blocked: (t) => t("marketplace.pluginInstallPanel.note.blocked", "blocked"),
  incomplete: (t) => t("marketplace.pluginInstallPanel.note.incomplete", "catalog incomplete"),
};

/** The version picker's suffix for the same problems. */
function versionNote(entry: ListingVersion, t: UiTranslator): string {
  const problem = versionProblem(entry);
  if (problem === "operating_system" && entry.macosMinVersion)
    return (
      " · " +
      t(
        "marketplace.pluginInstallPanel.note.requiresMacOs",
        "requires macOS {{version}} or newer",
        { version: entry.macosMinVersion },
      )
    );
  return problem ? " · " + PROBLEM_NOTES[problem](t) : "";
}

/** What the primary button offers for the chosen exact version. */
function primaryAction(listing: MarketplaceListing, version: string): Offer | Settled {
  const externalLsp = listing.kind === "lsp" && listing.installed && !listing.installed.managed;
  const installed = externalLsp ? undefined : listing.installed?.version;
  if (installed && version === installed) return SETTLED.installed;
  const entry = listing.versions.find((item) => item.version === version);
  if (entry?.unavailable === "protocol") return SETTLED.outdated;
  if (!entry) {
    if (
      listing.versions.length > 0 &&
      listing.versions.every((item) => versionProblem(item) === "blocked")
    )
      return SETTLED.blocked;
    return listing.availableHere ? SETTLED.choose : SETTLED.unavailable;
  }
  const problem = versionProblem(entry);
  if (problem === "operating_system" && entry.macosMinVersion)
    return {
      ...SETTLED.operating_system,
      label: (t) =>
        t("marketplace.pluginInstallPanel.requiresMacOs", "Requires macOS {{version}} or newer", {
          version: entry.macosMinVersion,
        }),
    };
  if (problem) return SETTLED[problem];
  if (!listing.availableHere) return SETTLED.unavailable;
  // Already downloaded and verified: what is left is the user's review.
  if (version === listing.pendingVersion)
    return {
      state: "settled",
      label: (t) =>
        t("marketplace.pluginInstallPanel.stagedUpdate", "Update {{version}} staged", { version }),
      icon: null,
    };
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
  const { t } = useUiTranslation();
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
              ? t("marketplace.pluginInstallPanel.applying", "Applying…")
              : listing.kind === "lsp" && listing.installed && !listing.installed.managed
                ? t(
                    "marketplace.pluginInstallPanel.installManaged",
                    "Install managed version {{version}}",
                    { version: action.version },
                  )
                : OFFER_LABELS[action.state](t, action.version)}
          </Button>
        )}
        <KindAction listing={listing} />
        <VersionSelect listing={listing} version={version} onVersionChange={onVersionChange} />
      </div>
      <TabInstallNote listing={listing} version={version} />
      <p className="text-xs text-muted-foreground">
        {listing.recommended
          ? t(
              "marketplace.pluginInstallPanel.recommended",
              "Recommended for this machine: {{version}}.",
              { version: listing.recommended },
            )
          : listing.availableHere
            ? t(
                "marketplace.pluginInstallPanel.noRecommendation",
                "No compatible version is recommended for this machine — choose one explicitly.",
              )
            : ""}{" "}
        {listing.installed
          ? t(
              "marketplace.pluginInstallPanel.chooseToChange",
              "Nothing changes until you choose another version.",
            )
          : ""}
        {!actions.canInstall(listing) && listing.inCatalog
          ? " " +
            t(
              "marketplace.pluginInstallPanel.verifiedCatalogRequired",
              "Installing needs a current verified catalog and a loaded inventory.",
            )
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
  const { t } = useUiTranslation();
  const installedVersion = listing.installed?.version;
  const orphan =
    !!installedVersion && !listing.versions.some((v) => v.version === installedVersion);
  return (
    <Select value={version} onValueChange={onVersionChange}>
      <SelectTrigger
        aria-label={t("marketplace.pluginInstallPanel.exactVersion", "Exact version")}
        className="order-last w-full text-xs sm:order-none sm:w-auto sm:min-w-40"
      >
        <SelectValue
          placeholder={t("marketplace.pluginInstallPanel.chooseAVersion", "Choose a version")}
        />
      </SelectTrigger>
      <SelectContent>
        {orphan && (
          <SelectItem value={installedVersion} className="text-xs">
            <span className="font-mono">{installedVersion}</span> ·{" "}
            {t(
              "marketplace.pluginInstallPanel.installedOutsideCatalog",
              "installed, not in catalog",
            )}
          </SelectItem>
        )}
        {listing.versions.map((entry) => (
          <SelectItem key={entry.version} value={entry.version} className="text-xs">
            <span className="font-mono">{entry.version}</span>
            {entry.version === listing.recommended
              ? " · " + t("marketplace.pluginInstallPanel.selectRecommended", "recommended")
              : ""}
            {entry.version === installedVersion
              ? " · " + t("marketplace.pluginInstallPanel.selectInstalled", "installed")
              : ""}
            {entry.version === listing.pendingVersion
              ? " · " + t("marketplace.pluginInstallPanel.selectAwaitingReview", "awaiting review")
              : ""}
            {versionNote(entry, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A settled state is not an offer: never a filled primary. */
export function SettledAction({ action }: { action: Settled }): React.JSX.Element {
  const { t } = useUiTranslation();
  const Icon = action.icon;
  return (
    <Button variant="secondary" disabled className="min-w-36 rounded-lg">
      {Icon && <Icon aria-hidden="true" />}
      {action.label(t)}
    </Button>
  );
}

/**
 * What an installed single kind does next. Theme: put it on screen. Provider:
 * whether it starts with Cadencr. Tab: enable it (asking consent first).
 */
export function KindAction({ listing }: { listing: MarketplaceListing }): React.JSX.Element | null {
  const { t } = useUiTranslation();
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
        {installed.active
          ? t("marketplace.pluginInstallPanel.inUse", "In use")
          : t("marketplace.pluginInstallPanel.useTheme", "Use this theme")}
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
      {installed.enabled
        ? t("marketplace.tabActivation.disable", "Disable")
        : t("marketplace.tabActivation.enable", "Enable")}
    </Button>
  );
}
