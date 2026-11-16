import { platformList, reasonClause } from "@/components/plugin-tabs/plugin-tab-access";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";
import { PLUGIN_TAB_ERROR } from "@/lib/plugin-tabs/error-codes";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { useMarketplaceState } from "./MarketplaceContext";

/** The service refusals of a tab install or update that the panel explains in place. */
const REFUSALS: Readonly<Record<string, (detail: string) => string>> = {
  [PLUGIN_TAB_ERROR.managedBlocked]: (detail) =>
    `Not installed: ${reasonClause(detail)}. This version is on Cadencr's revocation list — choose another one.`,
  [PLUGIN_TAB_ERROR.policyUnavailable]: () =>
    "Cadencr couldn't check its revocation list, so nothing was installed. Check your connection and try again.",
};

/**
 * Why a custom tab can't install here, under the install button: its native
 * backend ships no binary for this computer (known from the catalog, or from
 * the service's refusal) or speaks a protocol this Cadencr doesn't, the
 * version is blocked (known from the catalog, or from the refusal), or the
 * blocklist could not be checked.
 */
export function TabInstallNote({
  listing,
  version,
}: {
  listing: MarketplaceListing;
  version: string;
}): React.JSX.Element | null {
  const { tabs } = useMarketplaceState();
  if (listing.kind !== "tab") return null;
  const mutation = tabs.mutation;
  const ours = mutation.variables?.id === listing.id && mutation.variables.kind !== "remove";
  const code = ours ? apiErrorCode(mutation.error) : null;
  const refusal = code ? REFUSALS[code] : undefined;
  if (refusal) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {refusal(apiErrorMessage(mutation.error, "no reason given"))}
      </p>
    );
  }
  // With nothing installable here no version is offered: explain from the newest.
  const entry =
    listing.versions.find((item) => item.version === version) ??
    (listing.availableHere ? undefined : listing.versions[0]);
  const refused = code === PLUGIN_TAB_ERROR.platformUnsupported;
  if (
    !refused &&
    entry &&
    !entry.unavailable &&
    entry.blocked &&
    entry.version !== listing.installed?.version
  ) {
    return (
      <p role="status" className="text-xs text-destructive">
        Version {entry.version} is on Cadencr&apos;s revocation list: {reasonClause(entry.blocked)}.
        Choose another version.
      </p>
    );
  }
  if (!refused && !entry?.unavailable) return null;
  if (!refused && entry?.unavailable === "protocol") {
    return (
      <p role="status" className="text-xs text-[var(--acc-orange)]">
        Needs a newer Cadencr: version {entry.version}&apos;s native backend speaks protocol{" "}
        {entry.nativeCode?.protocol ?? "unknown"}, which this Cadencr doesn&apos;t.
        {listing.availableHere ? " Choose another version." : " Update Cadencr to install it."}
      </p>
    );
  }
  const platforms = entry?.platforms.length ? platformList(entry.platforms) : null;
  return (
    <p role="status" className="text-xs text-[var(--acc-orange)]">
      Not available on this platform: its native backend ships
      {platforms ? ` for ${platforms} only` : " no build for this computer"}.
      {listing.availableHere && !refused ? " Choose another version." : ""}
    </p>
  );
}
