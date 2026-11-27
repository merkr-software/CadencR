import { reasonSentence } from "@/components/plugin-tabs/plugin-tab-access";
import { uiI18n, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { versionProblem } from "@/lib/marketplace-listing-base";
import { pluginOffer, pluginSteps, type PluginMember } from "@/lib/marketplace-plugin-listings";
import { useMarketplaceState } from "./MarketplaceContext";
import {
  OFFER_LABELS,
  SETTLED,
  SettledAction,
  VersionSelect,
  type Settled,
} from "./PluginInstallPanel";
import { memberLabel, pluginRunError, usePluginActions } from "./usePluginActions";

interface PluginOffer {
  label: string;
  version: string;
}

/** What the primary button offers for one release: install, finish, update or change it. */
function pluginAction(
  listing: MarketplaceListing,
  members: PluginMember[],
  version: string,
  t: UiTranslator,
): PluginOffer | Settled {
  // With nothing installable here no version is offered: explain from the newest.
  const entry =
    listing.versions.find((item) => item.version === version) ??
    (listing.availableHere ? undefined : listing.versions[0]);
  if (!entry) return SETTLED.choose;
  const problem = versionProblem(entry);
  if (problem) return SETTLED[problem];
  const steps = pluginSteps(members, version);
  const offer = pluginOffer(listing, steps, version);
  if (!offer) return SETTLED.installed;
  if (offer === "complete")
    return {
      label: t("marketplace.pluginPackagePanel.installMissing", "Install {{count}} missing", {
        count: steps.length,
      }),
      version,
    };
  return { label: OFFER_LABELS[offer](t, version), version };
}

const joinNames = (members: MarketplaceListing[]) =>
  new Intl.ListFormat(uiI18n.language).format(members.map((m) => m.name));

/** What is left to do once members are in: tabs to turn on, providers to restart. */
function NextSteps({ members }: { members: PluginMember[] }): React.JSX.Element | null {
  const { t } = useUiTranslation();
  const installed = members.flatMap((member) => (member.listing?.installed ? member.listing : []));
  const tabsOff = installed.filter((m) => m.kind === "tab" && !m.installed?.enabled);
  const restart = installed.filter((m) => m.installed?.restartRequired);
  if (!tabsOff.length && !restart.length) return null;
  return (
    <div className="space-y-1 text-xs">
      {tabsOff.length > 0 && (
        <p className="text-muted-foreground">
          {t(
            "marketplace.pluginPackagePanel.enableTabsNext",
            "{{names}} are installed but off. Enable them under Includes — enabling asks for your consent first.",
            {
              count: tabsOff.length,
              names: joinNames(tabsOff),
              defaultValue_zero:
                "{{names}} are installed but off. Enable them under Includes — enabling asks for your consent first.",
              defaultValue_one:
                "{{names}} is installed but off. Enable it under Includes — enabling asks for your consent first.",
            },
          )}
        </p>
      )}
      {restart.length > 0 && (
        <p className="flex items-center gap-1.5 text-[var(--acc-yellow)]">
          <RotateCw aria-hidden="true" className="size-3.5 shrink-0" />
          {t(
            "marketplace.pluginPackagePanel.restartForMembers",
            "Restart Cadencr to apply {{names}}.",
            { names: joinNames(restart) },
          )}
        </p>
      )}
    </div>
  );
}

/** Install or move every member to one release, in turn, and say where it stands. */
export function PluginPackagePanel({
  listing,
  members,
  version,
  onVersionChange,
}: {
  listing: MarketplaceListing;
  members: PluginMember[];
  version: string;
  onVersionChange: (version: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const { pluginRun } = useMarketplaceState();
  const actions = usePluginActions();
  const action = pluginAction(listing, members, version, t);
  const run = pluginRun?.key === listing.key ? pluginRun : null;
  const unresolved = members.some((member) => !member.listing);
  const unknownKinds = listing.versions.find((entry) => entry.version === version)?.unknownKinds;
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {"state" in action ? (
          <SettledAction action={action} />
        ) : (
          <Button
            className="min-w-36 rounded-lg"
            disabled={!actions.canInstall(listing) || actions.busy(listing) || unresolved}
            onClick={() => actions.install(listing, action.version)}
          >
            {run?.status === "running" && <Loader2 aria-hidden="true" className="animate-spin" />}
            {run?.status === "running"
              ? t("marketplace.pluginRun.installingProgress", "Installing {{step}} of {{total}}…", {
                  step: run.step,
                  total: run.total,
                })
              : action.label}
          </Button>
        )}
        <VersionSelect listing={listing} version={version} onVersionChange={onVersionChange} />
      </div>
      {run?.status === "running" && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("marketplace.pluginRun.installingMember", "Installing {{member}}…", {
            member: memberLabel(run.member, t),
          })}
        </p>
      )}
      {run?.status === "failed" && action !== SETTLED.installed && (
        <p role="alert" className="text-xs text-destructive">
          {t(
            "marketplace.pluginPackagePanel.installStopped",
            "Stopped at {{member}}: {{message}} Members before it stay installed; nothing after it was changed.",
            {
              member: memberLabel(run.member, t),
              message: reasonSentence(pluginRunError(run.error, t)),
            },
          )}
        </p>
      )}
      {unknownKinds?.length ? (
        <p role="status" className="text-xs text-[var(--acc-orange)]">
          {t(
            "marketplace.pluginPackagePanel.unknownKinds",
            "Needs a newer Cadencr: this release adds {{kinds}}, which this Cadencr doesn't know. Update Cadencr to install it.",
            { kinds: unknownKinds.join(", ") },
          )}
        </p>
      ) : null}
      <NextSteps members={members} />
      <p className="text-xs text-muted-foreground">
        {listing.recommended
          ? t(
              "marketplace.pluginInstallPanel.recommended",
              "Recommended for this machine: {{version}}.",
              { version: listing.recommended },
            )
          : listing.availableHere
            ? t(
                "marketplace.pluginPackagePanel.noRecommendedRelease",
                "No release is recommended for every component on this machine — choose one explicitly.",
              )
            : ""}{" "}
        {t(
          "marketplace.pluginPackagePanel.sequentialInstall",
          "Installs each component in turn and stops at the first failure.",
        )}
        {!actions.canInstall(listing) && listing.inCatalog
          ? " " +
            t(
              "marketplace.pluginPackagePanel.catalogsRequired",
              "Installing needs a current verified catalog and a loaded inventory for every kind it adds.",
            )
          : ""}
      </p>
    </div>
  );
}
