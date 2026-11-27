import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { Ban, CpuIcon, Loader2, ShieldAlert } from "lucide-react";
import { useGetManagedTabPolicy } from "@/api/generated";
import { platformList } from "@/components/plugin-tabs/plugin-tab-access";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatAgo } from "@/lib/date-utils";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import type { TabNativeCode } from "@/lib/marketplace-tab-package";

type ListingVersion = MarketplaceListing["versions"][number];

/**
 * The version the warning is about — the one the install button acts on (the
 * chosen, else the offered one; the newest listed when none is) — and the
 * native code it ships. A version no longer in the catalog is the installed
 * revision: what Cadencr runs for it.
 */
function reviewedVersion(
  listing: MarketplaceListing,
  version: string,
): { entry?: ListingVersion; native: TabNativeCode | null } {
  const entry =
    listing.versions.find((item) => item.version === version) ??
    (version ? undefined : listing.versions[0]);
  if (entry) return { entry, native: entry.nativeCode ?? null };
  if (version && version === listing.installed?.version)
    return { native: listing.installedNativeCode ?? null };
  return { native: null };
}

/**
 * Trust & safety for a custom tab: where its page runs and, for a tab that
 * ships a native backend, that the program runs as the user, why, and where.
 * Shown before download — the signed catalog declares the backend — so the
 * user knows before installing; the consent dialog asks again when enabling.
 * It describes `version`, the one the install panel would install or update to.
 */
export function TabTrust({
  listing,
  version,
}: {
  listing: MarketplaceListing;
  version: string;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const { entry, native } = reviewedVersion(listing, version);
  return (
    <>
      <p>
        {t(
          "marketplace.tabTrust.isolation",
          "A custom tab's page runs in an isolated view: it reaches Cadencr data only through the permissions you allow, and the network only through the sites it declares. Installing turns nothing on and grants nothing. Enabling asks for your consent, and an update that asks for more waits for it again.",
        )}
      </p>
      {native ? (
        <div className="space-y-1.5 border-t border-border/60 pt-2">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <CpuIcon aria-hidden="true" className="size-3.5 shrink-0 text-[var(--acc-red)]" />
            {t(
              "marketplace.tabTrust.runsNativeCodeWithYourRights",
              "Runs native code with your rights",
            )}
          </p>
          <p>
            <span className="text-foreground/80">{t("marketplace.tabTrust.why", "Why:")} </span>
            {native.reasoning}
          </p>
          <p>
            {entry ? (
              <UiTrans
                i18nKey="marketplace.tabTrust.versionPlatforms"
                defaults="Version <version>{{version}}</version> ships for {{platforms}}."
                values={{ version: entry.version, platforms: platformList(native.platforms, t) }}
                components={{ version: <span className="font-mono text-foreground" /> }}
              />
            ) : (
              t("marketplace.tabTrust.platforms", "Ships for {{platforms}}.", {
                platforms: platformList(native.platforms, t),
              })
            )}{" "}
            {t(
              "marketplace.tabTrust.nativePermissions",
              "Its program runs on your computer as you, outside any sandbox: it can read and change your files and use the network. Cadencr checks it against the signed catalog before every start and asks you to confirm when you enable the tab.",
            )}
          </p>
          <PolicyLine />
          {entry?.unavailable && (
            <p className="flex items-center gap-1.5 font-medium text-[var(--acc-orange)]">
              <Ban aria-hidden="true" className="size-3.5 shrink-0" />
              {entry.unavailable === "protocol"
                ? t("marketplace.tabTrust.needsNewerCadencr", "Needs a newer Cadencr")
                : t("marketplace.tabTrust.platformUnsupported", "Not available on this platform")}
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * Whether Cadencr can vouch that this native code is not revoked: backends
 * start only while the revocation list is current. Says nothing in a build
 * with no list configured.
 */
function PolicyLine(): React.JSX.Element | null {
  const { t } = useUiTranslation();
  const policy = useGetManagedTabPolicy({ query: { staleTime: 60_000 } });
  if (policy.isPending) {
    return (
      <p role="status" className="flex items-center gap-1.5">
        <Loader2 aria-hidden="true" className="size-3 animate-spin" />
        {t("marketplace.tabTrust.checkingTheRevocationList", "Checking the revocation list…")}
      </p>
    );
  }
  if (policy.isError) {
    return (
      <p role="alert" className="text-destructive">
        {t("marketplace.tabTrust.policyFailed", "Revocation list status unavailable: {{message}}", {
          message: apiErrorMessage(
            policy.error,
            t("marketplace.tabTrust.policyRequestFailed", "the request failed"),
          ),
        })}
      </p>
    );
  }
  const status = policy.data;
  if (status.cache_status === "not_configured")
    return (
      <p className="flex items-start gap-1.5 text-[var(--acc-orange)]">
        <ShieldAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span>
          {t(
            "marketplace.tabTrust.policyUnconfigured",
            "This build has no revocation list for custom tabs — they can't be installed, and native code won't start.",
          )}
        </span>
      </p>
    );
  if (status.cache_status === "fresh") {
    const published = formatAgo(status.generated_at);
    return (
      <p>
        {published
          ? t(
              "marketplace.tabTrust.policyPublished",
              "Revocation list is current (published {{published}}).",
              { published },
            )
          : t("marketplace.tabTrust.policyCurrent", "Revocation list is current.")}
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-[var(--acc-orange)]">
      <ShieldAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span>
        {t(
          "marketplace.tabTrust.policyUnavailable",
          "Revocation list not reachable — native code won't start until it is.",
        )}
        {status.detail ? (
          <span className="block text-muted-foreground">
            {t("marketplace.tabTrust.policyLastAttempt", "Last attempt: {{detail}}", {
              detail: status.detail,
            })}
          </span>
        ) : null}
      </span>
    </p>
  );
}
