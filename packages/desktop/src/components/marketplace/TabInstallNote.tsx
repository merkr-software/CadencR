import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { platformList, reasonClause } from "@/components/plugin-tabs/plugin-tab-access";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";
import { PLUGIN_TAB_ERROR } from "@/lib/plugin-tabs/error-codes";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { useMarketplaceState } from "./MarketplaceContext";

/** The service refusals of a tab install or update that the panel explains in place. */
const REFUSALS: Readonly<Record<string, (t: UiTranslator, detail: string) => string>> = {
  [PLUGIN_TAB_ERROR.managedBlocked]: (t, detail) =>
    t(
      "marketplace.tabInstallNote.blockedFailure",
      "Not installed: {{reason}}. This version is on Cadencr's revocation list — choose another one.",
      { reason: reasonClause(detail) },
    ),
  [PLUGIN_TAB_ERROR.policyUnavailable]: (t) =>
    t(
      "marketplace.tabInstallNote.policyFailed",
      "Cadencr couldn't check its revocation list, so nothing was installed. Check your connection and try again.",
    ),
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
  const { t } = useUiTranslation();
  const { tabs } = useMarketplaceState();
  if (listing.kind !== "tab") return null;
  const mutation = tabs.mutation;
  const ours = mutation.variables?.id === listing.id && mutation.variables.kind !== "remove";
  const code = ours ? apiErrorCode(mutation.error) : null;
  const refusal = code ? REFUSALS[code] : undefined;
  if (refusal) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {refusal(
          t,
          apiErrorMessage(
            mutation.error,
            t("marketplace.tabInstallNote.noReason", "no reason given"),
          ),
        )}
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
        {t(
          "marketplace.tabInstallNote.blockedVersion",
          "Version {{version}} is on Cadencr's revocation list: {{reason}}. Choose another version.",
          { version: entry.version, reason: reasonClause(entry.blocked) },
        )}
      </p>
    );
  }
  if (!refused && !entry?.unavailable) return null;
  if (!refused && entry?.unavailable === "protocol") {
    return (
      <p role="status" className="text-xs text-[var(--acc-orange)]">
        {t(
          "marketplace.tabInstallNote.incompatibleProtocol",
          "Needs a newer Cadencr: version {{version}}'s native backend speaks protocol {{protocol}}, which this Cadencr doesn't.",
          {
            version: entry.version,
            protocol:
              entry.nativeCode?.protocol ??
              t("marketplace.tabInstallNote.unknownProtocol", "unknown"),
          },
        )}{" "}
        {listing.availableHere
          ? t("marketplace.tabInstallNote.chooseAnotherVersion", "Choose another version.")
          : t("marketplace.tabInstallNote.updateCadencr", "Update Cadencr to install it.")}
      </p>
    );
  }
  const platforms = entry?.platforms.length ? platformList(entry.platforms, t) : null;
  return (
    <p role="status" className="text-xs text-[var(--acc-orange)]">
      {platforms
        ? t(
            "marketplace.tabInstallNote.otherPlatformsOnly",
            "Not available on this platform: its native backend ships for {{platforms}} only.",
            { platforms },
          )
        : t(
            "marketplace.tabInstallNote.noPlatformBuild",
            "Not available on this platform: its native backend ships no build for this computer.",
          )}
      {listing.availableHere && !refused && (
        <> {t("marketplace.tabInstallNote.chooseAnotherVersion", "Choose another version.")}</>
      )}
    </p>
  );
}
