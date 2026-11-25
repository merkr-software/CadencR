import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import { useBinaryDiscovery } from "@/api/generated";
import type { DiscoveredCandidate, DiscoveredSource, ProviderDiscovery } from "@/api/generated";
import { cn } from "@/lib/utils";
import { SettingsHeading } from "./SettingsHeading";
import { ErrorRow, LoadingRow } from "./SettingsStateRows";

/**
 * Provider-neutral panel that lists every discovered CLI install for a given
 * provider, the currently-selected one (highest semver), the user's override
 * if any, and where the override is consulted via `apply_binary_overrides_from_settings`.
 *
 * Backed by `GET /api/agents/binary-discovery`. The same query feeds every
 * instance — React Query dedupes — so multiple sections on the page only
 * trigger one network request.
 */
export function BinaryDiscoverySection({
  discoveryKey,
  description,
}: {
  /** Key into `BinaryDiscoveryResponse.providers`. */
  discoveryKey: string;
  description: ReactNode;
}) {
  const { t } = useUiTranslation();
  const query = useBinaryDiscovery();
  const provider = query.data?.providers[discoveryKey];

  return (
    <section className="space-y-3">
      <SettingsHeading
        title={t("settings.providers.discovery.title", "CLI binary")}
        description={description}
      />

      {query.isLoading ? (
        <LoadingRow label={t("onboarding.discovery.loading", "Discovering installs…")} />
      ) : query.isError ? (
        <ErrorRow label={t("settings.providers.discovery.error", "Failed to discover installs.")} />
      ) : !provider ? (
        <ErrorRow
          label={t(
            "settings.providers.discovery.noData",
            "No discovery data returned for {{provider}}.",
            { provider: discoveryKey },
          )}
        />
      ) : (
        <ProviderCard provider={provider} />
      )}
    </section>
  );
}

function ProviderCard({ provider }: { provider: ProviderDiscovery }) {
  const { candidates, selected, override_path: overridePath } = provider;
  const selectedCanonical = selected?.canonical ?? null;

  return (
    <div className="space-y-3">
      <SummaryRow
        binName={provider.bin_name}
        selected={selected ?? null}
        overridePath={overridePath ?? null}
      />

      {candidates.length === 0 ? (
        <ErrorRow
          label={
            <UiTrans
              i18nKey="settings.providers.discovery.noInstalls"
              defaults="No <binary>{{binary}}</binary> installations found. Set an override path in onboarding to point Cadencr at the binary."
              values={{ binary: provider.bin_name }}
              components={{ binary: <strong /> }}
            />
          }
        />
      ) : (
        <div className="rounded-md border border-border bg-card overflow-hidden">
          {candidates.map((candidate) => (
            <CandidateRow
              key={candidate.canonical}
              candidate={candidate}
              isSelected={candidate.canonical === selectedCanonical}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryRow({
  binName,
  selected,
  overridePath,
}: {
  binName: string;
  selected: DiscoveredCandidate | null;
  overridePath: string | null;
}) {
  const { t } = useUiTranslation();
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3 space-y-1 text-sm">
      <div>
        <span className="text-muted-foreground">
          {t("settings.providers.discovery.binary", "Binary:")}
        </span>{" "}
        <code className="font-mono text-xs">{binName}</code>
      </div>
      <div>
        <span className="text-muted-foreground">
          {t("settings.providers.discovery.active", "Active install:")}
        </span>{" "}
        {selected ? (
          <code className="font-mono text-xs">
            {selected.path}
            {selected.version
              ? ` (v${selected.version})`
              : t("settings.providers.discovery.unknownVersionSuffix", " (version unknown)")}
          </code>
        ) : (
          <span className="text-destructive">
            {t(
              "settings.providers.discovery.noneActive",
              "None. Cadencr cannot spawn this provider.",
            )}
          </span>
        )}
      </div>
      <div>
        <span className="text-muted-foreground">
          {t("settings.providers.discovery.overrideSetting", "Override (settings):")}
        </span>{" "}
        {overridePath ? (
          <code className="font-mono text-xs">{overridePath}</code>
        ) : (
          <span className="text-muted-foreground italic">
            {t("settings.providers.discovery.unset", "unset")}
          </span>
        )}
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  isSelected,
}: {
  candidate: DiscoveredCandidate;
  isSelected: boolean;
}) {
  const { t } = useUiTranslation();
  const showsCanonical = candidate.canonical !== candidate.path;
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 px-4 py-2.5 border-border first:border-t-0 border-t",
        isSelected && "bg-primary/5",
      )}
    >
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <code className="font-mono text-xs truncate">{candidate.path}</code>
          {isSelected && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary text-primary-foreground inline-flex items-center gap-1">
              <CheckCircle2 className="size-3" />{" "}
              {t("settings.providers.discovery.selected", "Selected")}
            </span>
          )}
          <SourceBadge source={candidate.source} />
        </div>
        {showsCanonical && (
          <div className="text-[11px] text-muted-foreground">
            <span className="text-muted-foreground/70">
              {t("settings.providers.discovery.resolvesTo", "resolves to:")}
            </span>{" "}
            <code className="font-mono">{candidate.canonical}</code>
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground tabular-nums whitespace-nowrap pt-0.5">
        {candidate.version
          ? `v${candidate.version}`
          : t("settings.providers.discovery.unknownVersion", "version unknown")}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: DiscoveredSource }) {
  const { t } = useUiTranslation();
  const labels: Record<DiscoveredSource, string> = {
    override: t("settings.providers.discovery.source.override", "Override"),
    login_shell_path: t("settings.providers.discovery.source.loginShell", "Login shell"),
    env_path: "PATH",
    well_known: t("settings.providers.discovery.source.wellKnown", "Well-known"),
  };
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] uppercase bg-secondary text-secondary-foreground">
      {labels[source]}
    </span>
  );
}
