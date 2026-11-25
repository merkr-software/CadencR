import { translateUi, UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Info, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { openExternalUrl } from "@/lib/open-external";
import { cn } from "@/lib/utils";
import { useMarketplaceState } from "./MarketplaceContext";
import { formatAgo } from "@/lib/date-utils";
import { formatDay } from "./PluginBits";
import { ProviderTrust } from "./ProviderTrust";
import { TabTrust } from "./TabTrust";

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function VersionsSection({
  listing,
  version,
  onVersionChange,
}: {
  listing: MarketplaceListing;
  version: string;
  onVersionChange: (version: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <Section
      title={t("marketplace.pluginDetailSections.versionsCount", "Versions · {{count}}", {
        count: listing.versions.length,
      })}
    >
      {listing.versions.length ? (
        <ul className="overflow-hidden rounded-lg border border-border/80">
          {listing.versions.map((entry) => (
            <li key={entry.version} className="border-b border-border/60 last:border-b-0">
              <button
                type="button"
                aria-pressed={entry.version === version}
                onClick={() => onVersionChange(entry.version)}
                className={cn(
                  "flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left transition-colors",
                  "hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:outline-none",
                  entry.version === version && "bg-primary/7",
                )}
              >
                <span className="w-24 font-mono text-[12px] font-medium">{entry.version}</span>
                {entry.version === listing.recommended && (
                  <Badge
                    variant="ghost"
                    className={cn(
                      "px-1.5 py-0 text-[10.5px]",
                      // Primary marks the recommendation only while it is still an offer.
                      entry.version === listing.installed?.version
                        ? "bg-foreground/8 text-muted-foreground"
                        : "bg-primary/12 text-primary",
                    )}
                  >
                    {t("marketplace.pluginDetailSections.recommended", "Recommended")}
                  </Badge>
                )}
                {entry.version === listing.installed?.version && (
                  <Badge
                    variant="ghost"
                    className="bg-foreground/8 px-1.5 py-0 text-[10.5px] text-muted-foreground"
                  >
                    {t("marketplace.pluginDetailSections.installed", "Installed")}
                  </Badge>
                )}
                {entry.blocked && (
                  <Badge
                    variant="ghost"
                    title={entry.blocked}
                    className="bg-destructive/10 px-1.5 py-0 text-[10.5px] text-destructive"
                  >
                    {t("marketplace.pluginDetailSections.blocked", "Blocked")}
                  </Badge>
                )}
                <span className="ml-auto text-[11px] text-muted-foreground">
                  <UiTrans
                    i18nKey="marketplace.pluginDetailSections.cadencrVersion"
                    defaults="Cadencr <version>{{range}}</version>"
                    values={{
                      range: entry.maxApp
                        ? `${entry.minApp} – ${entry.maxApp}`
                        : `${entry.minApp}+`,
                    }}
                    components={{ version: <span className="font-mono text-[10.5px]" /> }}
                  />
                  {entry.platforms.length
                    ? " · " +
                      t("marketplace.pluginDetailSections.platformCount", "{{count}} platforms", {
                        count: entry.platforms.length,
                        defaultValue_zero: "{{count}} platforms",
                        defaultValue_one: "{{count}} platform",
                      })
                    : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(
            "marketplace.pluginDetailSections.thisPluginIsNoLongerInThe",
            "This plugin is no longer in the catalog.",
          )}
        </p>
      )}
    </Section>
  );
}

export function ExternalLinkValue({ url }: { url: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() =>
        void openExternalUrl(
          url,
          translateUi("marketplace.pluginDetailSections.openLinkFailed", "Could not open the link"),
        )
      }
      className="inline-flex max-w-full items-center gap-1 truncate text-left text-primary hover:underline"
    >
      <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
    </button>
  );
}

export function FactsSection({ listing }: { listing: MarketplaceListing }): React.JSX.Element {
  const { t } = useUiTranslation();
  const facts: MarketplaceFact[] = [
    [
      "publisher",
      t("marketplace.pluginDetailSections.publisher", "Publisher"),
      listing.publisher ?? "—",
    ],
    [
      "identifier",
      t("marketplace.pluginDetailSections.identifier", "Identifier"),
      <span className="break-all font-mono text-[11.5px]">{listing.id}</span>,
    ],
    [
      "license",
      t("marketplace.pluginDetailSections.license", "License"),
      listing.license ?? t("marketplace.pluginDetailSections.notSpecified", "Not specified"),
    ],
  ];
  if (listing.partOf)
    facts.push([
      "partOf",
      t("marketplace.pluginDetailSections.partOf", "Part of"),
      <Link
        to="/marketplace/$kind/$id"
        params={{ kind: "plugin", id: listing.partOf.id }}
        className="text-primary hover:underline"
      >
        {listing.partOf.name}
      </Link>,
    ]);
  if (listing.authors.length)
    facts.push([
      "authors",
      t("marketplace.pluginDetailSections.authors", "Authors"),
      listing.authors.join(", "),
    ]);
  if (listing.repository)
    facts.push([
      "source",
      t("marketplace.pluginDetailSections.source", "Source"),
      <ExternalLinkValue url={listing.repository} />,
    ]);
  if (listing.website)
    facts.push([
      "website",
      t("marketplace.pluginDetailSections.website", "Website"),
      <ExternalLinkValue url={listing.website} />,
    ]);
  if (listing.installed?.installedAt)
    facts.push([
      "installed",
      t("marketplace.pluginDetailSections.installed", "Installed"),
      formatDay(listing.installed.installedAt),
    ]);
  if (listing.installed?.updatedAt && listing.installed.updatedAt !== listing.installed.installedAt)
    facts.push([
      "updated",
      t("marketplace.pluginDetailSections.lastUpdated", "Last updated"),
      `${formatDay(listing.installed.updatedAt)} (${formatAgo(listing.installed.updatedAt)})`,
    ]);
  return <DetailsSection facts={facts} />;
}

export type MarketplaceFact = [id: string, label: string, value: React.ReactNode];

/** The "Details" label/value list of a detail page's sidebar. */
export function DetailsSection({
  facts,
}: {
  facts: readonly MarketplaceFact[];
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <Section title={t("marketplace.pluginDetailSections.details", "Details")}>
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
        {facts.map(([id, label, value]) => (
          <div key={id} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function TrustSection({
  listing,
  version,
}: {
  listing: MarketplaceListing;
  /** The version the install panel acts on; the tab warning describes it. */
  version: string;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const { providers, themes, tabs, lsps } = useMarketplaceState();
  const externalLsp = listing.kind === "lsp" && !!listing.installed && !listing.installed.managed;
  const invalidLsp =
    listing.kind === "lsp" && !!listing.installed?.managed && !listing.installed.usable;
  const TrustIcon = externalLsp || invalidLsp ? Info : ShieldCheck;
  // Each kind is verified against its own catalog; never show the other one's dates.
  const providerCatalog = listing.kind === "provider" ? providers.catalogQuery.data : undefined;
  const expiresAt =
    !externalLsp &&
    (listing.kind === "provider"
      ? providerCatalog
      : listing.kind === "lsp"
        ? lsps.catalog.data
        : listing.kind === "tab"
          ? tabs.catalog.data
          : themes.catalog.data
    )?.index?.signed.expires_at;
  return (
    <Section title={t("marketplace.pluginDetailSections.trustSafety", "Trust & safety")}>
      <div className="space-y-2 rounded-lg border border-border/80 bg-card p-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <TrustIcon
            aria-hidden="true"
            className={cn("size-3.5", !externalLsp && !invalidLsp && "text-primary")}
          />
          {externalLsp
            ? t(
                "marketplace.pluginDetailSections.externalInstallation",
                "Installed outside the marketplace",
              )
            : invalidLsp
              ? t(
                  "marketplace.pluginDetailSections.marketplaceInstallUnavailable",
                  "Marketplace installation unavailable",
                )
              : t(
                  "marketplace.pluginDetailSections.signedCatalog",
                  "Signed catalog, verified archive",
                )}
        </p>
        <KindTrust listing={listing} version={version} />
        {expiresAt && (
          <p className="text-[11px]">
            {providerCatalog?.signer_key_id && (
              <>
                <UiTrans
                  i18nKey="marketplace.pluginDetailSections.signer"
                  defaults="Signer <identifier>{{id}}</identifier>"
                  values={{ id: providerCatalog.signer_key_id }}
                  components={{ identifier: <span className="font-mono text-[10.5px]" /> }}
                />{" "}
                ·{" "}
              </>
            )}
            {t("marketplace.pluginDetailSections.catalogExpires", "Catalog expires {{date}}", {
              date: formatDay(expiresAt),
            })}
          </p>
        )}
      </div>
    </Section>
  );
}

/** What installing one single-kind package runs, in that kind's own words. */
export function KindTrust({
  listing,
  version,
}: {
  listing: MarketplaceListing;
  version: string;
}): React.JSX.Element | null {
  const { t } = useUiTranslation();
  if (listing.kind === "theme")
    return (
      <p>
        {t(
          "marketplace.pluginDetailSections.themesAreDeclarativeValidatedColorsAndBounded",
          "Themes are declarative: validated colors and bounded images, never executables. Signed revisions are immutable — duplicate one to edit it. Installing does not switch your theme.",
        )}
      </p>
    );
  if (listing.kind === "tab") return <TabTrust listing={listing} version={version} />;
  if (listing.kind === "provider") return <ProviderTrust />;
  if (listing.kind === "lsp" && listing.installed?.managed && !listing.installed.usable)
    return (
      <p>
        {t(
          "marketplace.pluginDetailSections.cadencrCannotCurrentlyVerifyOrRunThis",
          "Cadencr cannot currently verify or run this installation. Review its error, refresh the marketplace or remove it.",
        )}
      </p>
    );
  if (listing.kind === "lsp" && listing.installed && !listing.installed.managed)
    return (
      <p>
        {t(
          "marketplace.pluginDetailSections.cadencrHasNotVerifiedThisExecutableAgainst",
          "Cadencr has not verified this executable against a signed marketplace package. Language servers run with your access to provide completions, navigation and diagnostics. Manage this installation with its original installer.",
        )}
      </p>
    );
  if (listing.kind === "lsp")
    return (
      <p>
        {t(
          "marketplace.pluginDetailSections.installingDownloadsAVerifiedExecutableLanguageServers",
          "Installing downloads a verified executable. Language servers run with your access to provide completions, navigation and diagnostics. They start only for matching files after installation.",
        )}
      </p>
    );
  return null;
}
