import type { ManagedBlocklistCacheStatus } from "@/api/generated";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useMarketplaceState } from "./MarketplaceContext";

const CACHE_LABELS: Record<ManagedBlocklistCacheStatus, (t: UiTranslator) => string> = {
  missing: (t) => t("marketplace.providerTrust.cache.missing", "missing"),
  verified: (t) => t("marketplace.providerTrust.cache.verified", "verified"),
  invalid: (t) => t("marketplace.providerTrust.cache.invalid", "invalid"),
};

export function ProviderTrust(): React.JSX.Element {
  const { t } = useUiTranslation();
  const inventory = useMarketplaceState().providers.inventoryQuery.data;
  const policy = inventory?.process_policy;
  const unavailable = policy
    ? [
        {
          label: t("marketplace.providerTrust.memoryLimit", "Memory limit"),
          control: policy.memory_limit,
        },
        {
          label: t("marketplace.providerTrust.childProcessLimit", "Child-process limit"),
          control: policy.child_count_limit,
        },
        { label: t("marketplace.providerTrust.cpuLimit", "CPU limit"), control: policy.cpu_limit },
        {
          label: t("marketplace.providerTrust.descendantTermination", "Descendant termination"),
          control: policy.descendant_termination,
        },
      ].flatMap(({ label, control }) =>
        control.status === "unavailable" ? [{ label, reason: control.reason }] : [],
      )
    : [];
  return (
    <>
      <p>
        {t(
          "marketplace.pluginDetailSections.installingDownloadsAndRunsThisPublisherSExecutable",
          "Installing downloads and runs this publisher’s executable. Cadencr verifies the signed catalog, package integrity, compatibility and the ACP handshake — this is not an OS sandbox: the executable runs with your access. Use an isolated environment for untrusted providers. Changes may need a restart.",
        )}
      </p>
      {inventory && inventory.trust.status !== "configured" && (
        <p className="text-destructive">
          {inventory.trust.status === "invalid"
            ? t(
                "marketplace.providerTrust.invalidSigningTrust",
                "Signing trust: invalid. {{error}}",
                { error: inventory.trust.error ?? "" },
              )
            : t(
                "marketplace.providerTrust.unconfiguredSigningTrust",
                "Signing trust: unconfigured. {{error}}",
                { error: inventory.trust.error ?? "" },
              )}
        </p>
      )}
      {inventory && (
        <p>
          {inventory.blocklist.source_configured
            ? t(
                "marketplace.providerTrust.blocklistConfigured",
                "Blocklist configured · cache {{status}}",
                {
                  status:
                    CACHE_LABELS[inventory.blocklist.cache_status]?.(t) ??
                    inventory.blocklist.cache_status,
                },
              )
            : t(
                "marketplace.providerTrust.blocklistUnconfigured",
                "Blocklist not configured · cache {{status}}",
                {
                  status:
                    CACHE_LABELS[inventory.blocklist.cache_status]?.(t) ??
                    inventory.blocklist.cache_status,
                },
              )}
        </p>
      )}
      {unavailable.map(({ label, reason }) => (
        <p key={label}>
          {t(
            "marketplace.providerTrust.controlUnavailable",
            "{{label}}: unavailable — {{reason}}",
            { label, reason },
          )}
        </p>
      ))}
    </>
  );
}
