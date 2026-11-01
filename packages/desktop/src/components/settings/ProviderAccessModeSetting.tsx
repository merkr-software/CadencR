import { useMemo } from "react";
import { useAgentCatalog } from "@/api/agentRuntime";
import { RadioCardGroup } from "@/components/settings/RadioCardGroup";
import { SettingsHeading } from "@/components/settings/SettingsHeading";
import { ErrorRow, LoadingRow } from "@/components/settings/SettingsStateRows";
import { useAccessModeSetting } from "@/hooks/useAccessModeSetting";
import { providerAccessModeConfig } from "@/lib/provider-access-modes";
import type { AccessMode } from "@/types/access-mode";

interface ProviderAccessModeSettingProps {
  providerId: string;
}

export function ProviderAccessModeSetting({
  providerId,
}: ProviderAccessModeSettingProps): React.JSX.Element | null {
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
      accessModes?.map((option) => ({
        value: option.id,
        label: option.label,
        description: option.description,
      })) ?? [],
    [accessModes],
  );
  if (!config) return null;

  return (
    <div className="space-y-3">
      <SettingsHeading
        title={`${config.providerLabel} access mode`}
        description={`Applies to new ${config.providerLabel} conversations. Existing conversations keep their stored mode.`}
      />
      {catalog.isLoading ? (
        <LoadingRow label={`Loading ${config.providerLabel} access modes…`} />
      ) : catalog.isError || isError ? (
        <ErrorRow label={`Failed to load ${config.providerLabel} access modes.`} />
      ) : (
        <RadioCardGroup<AccessMode>
          value={globalAccessMode}
          onChange={handleAccessModeChange}
          options={options}
          ariaLabel={`${config.providerLabel} access mode`}
          layout="grid"
          columns={3}
          disabled={isLoading || isPending}
        />
      )}
    </div>
  );
}
