import { useUiTranslation } from "@/lib/i18n/ui";
import { memo } from "react";
import { cn } from "@/lib/utils";
import { PROVIDER_IDS, getProviderMetadata, type ProviderId } from "@/lib/providers";
import { ProviderIcon } from "@/lib/provider-icons";

interface ProviderOption {
  /** Canonical provider ID used by the catalog + icon asset map. */
  catalogId: ProviderId;
  path: string;
}

const PROVIDERS: readonly ProviderOption[] = [
  {
    catalogId: PROVIDER_IDS.CLAUDE_CODE,
    path: "~/.claude/projects/",
  },
  {
    catalogId: PROVIDER_IDS.CODEX_CLI,
    path: "~/.codex/sessions/",
  },
  {
    catalogId: PROVIDER_IDS.OPENCODE,
    path: "~/.local/share/opencode/",
  },
];

interface ImportProviderStepProps {
  /** Fired when the user picks a provider to import from. */
  onSelect: (providerId: ProviderId) => void;
}

function ImportProviderStepInner({ onSelect }: ImportProviderStepProps) {
  const { t } = useUiTranslation();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t(
          "conversation.importProviderStep.chooseWhereYourExistingConversationsLive",
          "Choose where your existing conversations live.",
        )}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {PROVIDERS.map((p) => {
          const meta = getProviderMetadata(p.catalogId);
          return (
            <ProviderCard
              key={p.catalogId}
              catalogId={p.catalogId}
              label={meta?.label ?? p.catalogId}
              description={t(
                "conversation.importProviderStep.sessionsStoredUnder",
                "Sessions stored under {{path}}",
                { path: p.path },
              )}
              onClick={() => onSelect(p.catalogId)}
            />
          );
        })}
      </div>
    </div>
  );
}

interface ProviderCardProps {
  catalogId: string;
  label: string;
  description: string;
  onClick: () => void;
}

function ProviderCard({ catalogId, label, description, onClick }: ProviderCardProps) {
  const { t } = useUiTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-1.5 rounded-md border border-border p-3 text-left transition-colors",
        "hover:border-primary hover:bg-accent/40 focus-visible:border-primary focus-visible:outline-none",
      )}
    >
      <div className="flex items-center gap-2">
        <ProviderIcon
          providerId={catalogId}
          alt={t("conversation.importProviderStep.providerLogo", "{{provider}} logo", {
            provider: label,
          })}
          className="size-5 rounded-sm"
        />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <span className="text-[11px] text-muted-foreground">{description}</span>
    </button>
  );
}

export const ImportProviderStep = memo(ImportProviderStepInner);
