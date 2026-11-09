import { useCallback, useMemo } from "react";
import { useGetWorkspaceSetting } from "@/api/generated";
import { useSettingWriter } from "@/hooks/useSetting";
import { useCatalogProviderMetadata } from "@/hooks/useCatalogProviderMetadata";
import {
  providerAccessModeConfig,
  type ProviderAccessModeConfig,
} from "@/lib/provider-access-modes";
import { parseAccessMode, type AccessMode } from "@/types/access-mode";
import { toast } from "sonner";

interface UseAccessModeSettingResult {
  globalAccessMode: AccessMode;
  isError: boolean;
  isLoading: boolean;
  isPending: boolean;
  providerLabel: string | null;
  handleAccessModeChange: (mode: AccessMode) => void;
}

/** {@link providerAccessModeConfig}, re-rendering when the provider's catalog entry changes. */
export function useProviderAccessModeConfig(
  providerId: string | undefined,
): ProviderAccessModeConfig | null {
  return providerAccessModeConfig(providerId, useCatalogProviderMetadata(providerId));
}

export function useAccessModeSetting(providerId: string): UseAccessModeSettingResult {
  const config = useProviderAccessModeConfig(providerId);
  const settingKey = config?.settingKey ?? "codex_permission_mode";
  const setting = useGetWorkspaceSetting(settingKey, { query: { enabled: config != null } });
  const { setValue, isSaving: isPending } = useSettingWriter(settingKey);
  const globalAccessMode = parseAccessMode(setting.data?.value);
  const providerLabel = config?.providerLabel ?? null;
  const handleAccessModeChange = useCallback(
    (mode: AccessMode): void => {
      if (!providerLabel || mode === globalAccessMode) return;
      void setValue(mode).then((saved) => {
        if (saved) toast.success(`${providerLabel} access default updated`);
      });
    },
    [globalAccessMode, providerLabel, setValue],
  );
  return useMemo(
    () => ({
      globalAccessMode,
      isError: setting.isError,
      isLoading: setting.isLoading,
      isPending,
      providerLabel,
      handleAccessModeChange,
    }),
    [
      globalAccessMode,
      handleAccessModeChange,
      isPending,
      providerLabel,
      setting.isError,
      setting.isLoading,
    ],
  );
}
