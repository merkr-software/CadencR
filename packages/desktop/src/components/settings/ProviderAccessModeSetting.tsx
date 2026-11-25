import { useUiTranslation } from "@/lib/i18n/ui";
import { useMemo } from "react";
import { useAgentCatalog } from "@/api/agentRuntime";
import { RadioCardGroup } from "@/components/settings/RadioCardGroup";
import { SettingsHeading } from "@/components/settings/SettingsHeading";
import { ErrorRow, LoadingRow } from "@/components/settings/SettingsStateRows";
import { useAccessModeSetting } from "@/hooks/useAccessModeSetting";
import { displayProviderAccessMode, providerAccessModeConfig } from "@/lib/provider-access-modes";
import type { AccessMode } from "@/types/access-mode";

interface ProviderAccessModeSettingProps {
  providerId: string;
}

export function ProviderAccessModeSetting({
  providerId,
}: ProviderAccessModeSettingProps): React.JSX.Element | null {
  const { t } = useUiTranslation();
  const catalog = useAgentCatalog();
  const entry = catalog.data?.providers.find((provider) => provider.id === providerId);
  const config = providerAccessModeConfig(
    providerId,
    entry ? { label: entry.label, accessModes: entry.access_modes ?? [] } : null,
  );
  const { globalAccessMode, handleAccessModeChange, isError, isLoading, isPending } =
    useAccessModeSetting(providerId);
  const accessModes = entry?.access_modes;
  const options = useMemo(
    () =>
      accessModes?.map((option) => {
        const { id, label, description } = displayProviderAccessMode(providerId, option, t);
        return { value: id, label, description };
      }) ?? [],
    [accessModes, providerId, t],
  );
  if (!config) return null;

  return (
    <div className="space-y-3">
      <SettingsHeading
        title={t("settings.providers.providerAccessModeSetting.title", "{{provider}} access mode", {
          provider: config.providerLabel,
        })}
        description={t(
          "settings.providers.providerAccessModeSetting.description",
          "Applies to new {{provider}} conversations. Existing conversations keep their stored mode.",
          { provider: config.providerLabel },
        )}
      />
      {catalog.isLoading ? (
        <LoadingRow
          label={t(
            "settings.providers.providerAccessModeSetting.loading",
            "Loading {{provider}} access modes…",
            { provider: config.providerLabel },
          )}
        />
      ) : catalog.isError || isError ? (
        <ErrorRow
          label={t(
            "settings.providers.providerAccessModeSetting.loadError",
            "Failed to load {{provider}} access modes.",
            { provider: config.providerLabel },
          )}
        />
      ) : (
        <RadioCardGroup<AccessMode>
          value={globalAccessMode}
          onChange={handleAccessModeChange}
          options={options}
          ariaLabel={t(
            "settings.providers.providerAccessModeSetting.title",
            "{{provider}} access mode",
            { provider: config.providerLabel },
          )}
          layout="grid"
          columns={3}
          disabled={isLoading || isPending}
        />
      )}
    </div>
  );
}
