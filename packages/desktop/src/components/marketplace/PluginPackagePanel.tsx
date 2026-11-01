import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { versionProblem } from "@/lib/marketplace-listing-base";
import { pluginOffer, pluginSteps, type PluginMember } from "@/lib/marketplace-plugin-listings";
import { useMarketplaceState } from "./MarketplaceContext";
import { LABELS, SETTLED, SettledAction, VersionSelect, type Settled } from "./PluginInstallPanel";
import { usePluginActions } from "./usePluginActions";

interface PluginOffer {
  label: string;
  version: string;
}

/** What the primary button offers for one release: install, finish, update or change it. */
function pluginAction(
  listing: MarketplaceListing,
  members: PluginMember[],
  version: string,
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
  if (offer === "complete") return { label: `Install ${steps.length} missing`, version };
  return { label: `${LABELS[offer]} ${version}`, version };
}

const joinNames = (members: MarketplaceListing[]) => members.map((m) => m.name).join(", ");

/** What is left to do once members are in: tabs to turn on, providers to restart. */
function NextSteps({ members }: { members: PluginMember[] }): React.JSX.Element | null {
  const installed = members.flatMap((member) => (member.listing?.installed ? member.listing : []));
  const tabsOff = installed.filter((m) => m.kind === "tab" && !m.installed?.enabled);
  const restart = installed.filter((m) => m.installed?.restartRequired);
  if (!tabsOff.length && !restart.length) return null;
  return (
    <div className="space-y-1 text-xs">
      {tabsOff.length > 0 && (
        <p className="text-muted-foreground">
          {joinNames(tabsOff)}{" "}
          {tabsOff.length === 1
            ? "is installed but off. Enable it"
            : "are installed but off. Enable them"}{" "}
          under Includes — enabling asks for your consent first.
        </p>
      )}
      {restart.length > 0 && (
        <p className="flex items-center gap-1.5 text-[var(--acc-yellow)]">
          <RotateCw aria-hidden="true" className="size-3.5 shrink-0" />
          Restart Cadencr to apply {joinNames(restart)}.
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
  const { pluginRun } = useMarketplaceState();
  const actions = usePluginActions();
  const action = pluginAction(listing, members, version);
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
            {run?.status === "running" ? `Installing ${run.step} of ${run.total}…` : action.label}
          </Button>
        )}
        <VersionSelect listing={listing} version={version} onVersionChange={onVersionChange} />
      </div>
      {run?.status === "running" && (
        <p role="status" className="text-xs text-muted-foreground">
          Installing {run.member}…
        </p>
      )}
      {run?.status === "failed" && action !== SETTLED.installed && (
        <p role="alert" className="text-xs text-destructive">
          Stopped at {run.member}: {run.message.replace(/\.?$/, ".")} Members before it stay
          installed; nothing after it was changed.
        </p>
      )}
      {unknownKinds?.length ? (
        <p role="status" className="text-xs text-[var(--acc-orange)]">
          Needs a newer Cadencr: this release adds {unknownKinds.join(", ")}, which this Cadencr
          doesn&apos;t know. Update Cadencr to install it.
        </p>
      ) : null}
      <NextSteps members={members} />
      <p className="text-xs text-muted-foreground">
        {listing.recommended
          ? `Recommended for this machine: ${listing.recommended}.`
          : listing.availableHere
            ? "No release is recommended for every component on this machine — choose one explicitly."
            : ""}{" "}
        Installs each component in turn and stops at the first failure.
        {!actions.canInstall(listing) && listing.inCatalog
          ? " Installing needs a current verified catalog and a loaded inventory for every kind it adds."
          : ""}
      </p>
    </div>
  );
}
