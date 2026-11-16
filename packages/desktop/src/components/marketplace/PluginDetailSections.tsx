import { Link } from "@tanstack/react-router";
import { ExternalLink, Info, ShieldCheck } from "lucide-react";
import type { ManagedProviderInventoryEntry } from "@/api/generated";
import { Badge } from "@/components/ui/badge";
import type { MarketplaceListing } from "@/lib/marketplace-listings";
import { openExternalUrl } from "@/lib/open-external";
import { cn } from "@/lib/utils";
import { useMarketplaceState } from "./MarketplaceContext";
import { formatAgo } from "@/lib/date-utils";
import { formatDay } from "./PluginBits";
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
  return (
    <Section title={`Versions · ${listing.versions.length}`}>
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
                    Recommended
                  </Badge>
                )}
                {entry.version === listing.installed?.version && (
                  <Badge
                    variant="ghost"
                    className="bg-foreground/8 px-1.5 py-0 text-[10.5px] text-muted-foreground"
                  >
                    Installed
                  </Badge>
                )}
                {entry.blocked && (
                  <Badge
                    variant="ghost"
                    title={entry.blocked}
                    className="bg-destructive/10 px-1.5 py-0 text-[10.5px] text-destructive"
                  >
                    Blocked
                  </Badge>
                )}
                <span className="ml-auto text-[11px] text-muted-foreground">
                  Cadencr <span className="font-mono text-[10.5px]">{entry.minApp}</span>
                  <span className="font-mono text-[10.5px]">
                    {entry.maxApp ? ` – ${entry.maxApp}` : "+"}
                  </span>
                  {entry.platforms.length
                    ? ` · ${entry.platforms.length} platform${entry.platforms.length > 1 ? "s" : ""}`
                    : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">This plugin is no longer in the catalog.</p>
      )}
    </Section>
  );
}

const ACTION_LABELS: Record<string, string> = {
  installed: "Installed",
  updated: "Updated",
  rolled_back: "Rolled back",
  enabled: "Enabled",
  disabled: "Disabled",
  removed: "Removed",
};

/** Confirmed installation changes and quarantines, newest first. */
export function HistorySection({
  entry,
}: {
  entry: ManagedProviderInventoryEntry;
}): React.JSX.Element {
  const events = [
    ...entry.history.map((event) => ({
      key: `h${event.sequence}`,
      at: event.occurred_at,
      label: ACTION_LABELS[event.action] ?? event.action,
      detail:
        event.previous_version && event.previous_version !== event.version
          ? `${event.previous_version} → ${event.version ?? "—"}`
          : (event.version ?? ""),
      failed: false,
    })),
    ...entry.quarantine.map((event) => ({
      key: `q${event.sequence}`,
      at: event.occurred_at,
      label: `Quarantined (${event.stage})`,
      detail: `${event.version} · ${event.code}: ${event.message}`,
      failed: true,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Section title="History">
      {events.length ? (
        <ol className="relative space-y-3 border-l border-border/80 pl-4">
          {events.map((event) => (
            <li key={event.key} className="relative">
              <span
                className={cn(
                  "absolute -left-[21px] top-1.5 size-2 rounded-full ring-4 ring-background",
                  event.failed ? "bg-destructive" : "bg-muted-foreground/60",
                )}
              />
              <p className={cn("text-[12.5px] font-medium", event.failed && "text-destructive")}>
                {event.label}{" "}
                <span className="font-mono text-[11px] font-normal text-muted-foreground">
                  {event.detail}
                </span>
              </p>
              <p className="text-[11px] tabular-nums text-muted-foreground" title={event.at}>
                {formatDay(event.at)} · {formatAgo(event.at)}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">No history recorded.</p>
      )}
    </Section>
  );
}

export function ExternalLinkValue({ url }: { url: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => void openExternalUrl(url, "Could not open the link")}
      className="inline-flex max-w-full items-center gap-1 truncate text-left text-primary hover:underline"
    >
      <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
    </button>
  );
}

export function FactsSection({ listing }: { listing: MarketplaceListing }): React.JSX.Element {
  const facts: [string, React.ReactNode][] = [
    ["Publisher", listing.publisher ?? "—"],
    ["Identifier", <span className="break-all font-mono text-[11.5px]">{listing.id}</span>],
    ["License", listing.license ?? "Not specified"],
  ];
  if (listing.partOf)
    facts.push([
      "Part of",
      <Link
        to="/marketplace/$kind/$id"
        params={{ kind: "plugin", id: listing.partOf.id }}
        className="text-primary hover:underline"
      >
        {listing.partOf.name}
      </Link>,
    ]);
  if (listing.authors.length) facts.push(["Authors", listing.authors.join(", ")]);
  if (listing.repository) facts.push(["Source", <ExternalLinkValue url={listing.repository} />]);
  if (listing.website) facts.push(["Website", <ExternalLinkValue url={listing.website} />]);
  if (listing.installed?.installedAt)
    facts.push(["Installed", formatDay(listing.installed.installedAt)]);
  if (listing.installed?.updatedAt && listing.installed.updatedAt !== listing.installed.installedAt)
    facts.push([
      "Last updated",
      `${formatDay(listing.installed.updatedAt)} (${formatAgo(listing.installed.updatedAt)})`,
    ]);
  return <DetailsSection facts={facts} />;
}

/** The "Details" label/value list of a detail page's sidebar. */
export function DetailsSection({
  facts,
}: {
  facts: readonly [string, React.ReactNode][];
}): React.JSX.Element {
  return (
    <Section title="Details">
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
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
    <Section title="Trust & safety">
      <div className="space-y-2 rounded-lg border border-border/80 bg-card p-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <TrustIcon
            aria-hidden="true"
            className={cn("size-3.5", !externalLsp && !invalidLsp && "text-primary")}
          />
          {externalLsp
            ? "Installed outside the marketplace"
            : invalidLsp
              ? "Marketplace installation unavailable"
              : "Signed catalog, verified archive"}
        </p>
        <KindTrust listing={listing} version={version} />
        {expiresAt && (
          <p className="text-[11px]">
            {providerCatalog?.signer_key_id && (
              <>
                Signer{" "}
                <span className="font-mono text-[10.5px]">{providerCatalog.signer_key_id}</span>{" "}
                ·{" "}
              </>
            )}
            Catalog expires {formatDay(expiresAt)}
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
  if (listing.kind === "theme")
    return (
      <p>
        Themes are declarative: validated colors and bounded images, never executables. Signed
        revisions are immutable — duplicate one to edit it. Installing does not switch your theme.
      </p>
    );
  if (listing.kind === "tab") return <TabTrust listing={listing} version={version} />;
  if (listing.kind === "provider") return <ProviderTrust />;
  if (listing.kind === "lsp" && listing.installed?.managed && !listing.installed.usable)
    return (
      <p>
        Cadencr cannot currently verify or run this installation. Review its error, refresh the
        marketplace or remove it.
      </p>
    );
  if (listing.kind === "lsp" && listing.installed && !listing.installed.managed)
    return (
      <p>
        Cadencr has not verified this executable against a signed marketplace package. Language
        servers run with your access to provide completions, navigation and diagnostics. Manage this
        installation with its original installer.
      </p>
    );
  if (listing.kind === "lsp")
    return (
      <p>
        Installing downloads a verified executable. Language servers run with your access to provide
        completions, navigation and diagnostics. They start only for matching files after
        installation.
      </p>
    );
  return null;
}

function ProviderTrust(): React.JSX.Element {
  const inventory = useMarketplaceState().providers.inventoryQuery.data;
  const policy = inventory?.process_policy;
  const unavailable = policy
    ? [
        { label: "Memory limit", control: policy.memory_limit },
        { label: "Child-process limit", control: policy.child_count_limit },
        { label: "CPU limit", control: policy.cpu_limit },
        { label: "Descendant termination", control: policy.descendant_termination },
      ].flatMap(({ label, control }) =>
        control.status === "unavailable" ? [{ label, reason: control.reason }] : [],
      )
    : [];
  return (
    <>
      <p>
        Installing downloads and runs this publisher’s executable. Cadencr verifies the signed
        catalog, package integrity, compatibility and the ACP handshake — this is not an OS sandbox:
        the executable runs with your access. Use an isolated environment for untrusted providers.
        Changes may need a restart.
      </p>
      {inventory && inventory.trust.status !== "configured" && (
        <p className="text-destructive">
          Signing trust: {inventory.trust.status}. {inventory.trust.error}
        </p>
      )}
      {inventory && (
        <p>
          Blocklist {inventory.blocklist.source_configured ? "configured" : "not configured"} ·
          cache {inventory.blocklist.cache_status}
        </p>
      )}
      {unavailable.map(({ label, reason }) => (
        <p key={label}>
          {label}: unavailable — {reason}
        </p>
      ))}
    </>
  );
}
