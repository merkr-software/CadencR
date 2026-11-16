import { useMemo, useState } from "react";
import { offeredVersion, type MarketplaceListing } from "@/lib/marketplace-listings";
import { pluginMembers } from "@/lib/marketplace-plugin-listings";
import { cn } from "@/lib/utils";
import { KINDS } from "./kinds";
import { useMarketplaceState } from "./MarketplaceContext";
import { FactsSection, VersionsSection } from "./PluginDetailSections";
import { DetailHero, DetailStage } from "./PluginHero";
import { IncludesSection, PluginTrustSection } from "./PluginIncludes";
import { PluginManage } from "./PluginManage";
import { PluginPackagePanel } from "./PluginPackagePanel";

/**
 * A multi-export plugin's page. It shows what one release adds (its members,
 * each with its own state and page) and acts on all of them at once; every
 * fact about state comes from the members, never from the plugin itself.
 */
export function PluginPackageBody({ listing }: { listing: MarketplaceListing }): React.JSX.Element {
  const { listingsByKey } = useMarketplaceState();
  const [chosen, setChosen] = useState<string | null>(null);
  // Recomputed until the user picks, like single packages: late inventory wins.
  const version = chosen ?? offeredVersion(listing);
  const members = useMemo(
    () => pluginMembers(listing, version, listingsByKey),
    [listing, version, listingsByKey],
  );
  const unknownKinds = listing.versions.find((entry) => entry.version === version)?.unknownKinds;
  return (
    <div className={cn("space-y-10", KINDS.plugin.tone)}>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="min-w-0 space-y-4">
          <DetailHero listing={listing} />
          <PluginPackagePanel
            listing={listing}
            members={members}
            version={version}
            onVersionChange={setChosen}
          />
        </div>
        <DetailStage listing={listing} version={version} />
      </section>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid min-w-0 content-start gap-10">
          <IncludesSection members={members} version={version} unknownKinds={unknownKinds} />
          <VersionsSection listing={listing} version={version} onVersionChange={setChosen} />
        </div>
        <aside className="min-w-0 space-y-8">
          <FactsSection listing={listing} />
          <PluginTrustSection members={members} version={version} />
          <PluginManage listing={listing} />
        </aside>
      </div>
    </div>
  );
}
