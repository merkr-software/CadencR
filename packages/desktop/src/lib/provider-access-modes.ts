import { PROVIDER_IDS } from "@/lib/providers";
import {
  getCatalogProviderMetadata,
  type CatalogProviderMetadata,
} from "@/lib/provider-catalog-registry";
import { CODEX_PERMISSION_MODE_SETTING_KEY } from "@/shared/permission-mode-settings";
export interface ProviderAccessModeConfig {
  providerLabel: string;
  settingKey: string;
}

/** The catalog facts an access-mode config is derived from. */
export type ProviderAccessCatalog = Pick<CatalogProviderMetadata, "label" | "accessModes">;

/** Codex predates the generic key and keeps its historical setting. */

const CONFIGS: Readonly<Record<string, ProviderAccessModeConfig>> = {
  [PROVIDER_IDS.CODEX_CLI]: {
    providerLabel: "Codex",
    settingKey: CODEX_PERMISSION_MODE_SETTING_KEY,
  },
};

/** Workspace setting holding a catalog-declared provider's access default. */
export function providerAccessModeSettingKey(providerId: string): string {
  return `provider_access_mode.${providerId}`;
}

/**
 * Whether a provider has an access axis (chip, settings row, remembered
 * default) and where its workspace default lives. Any provider outside the
 * built-in table qualifies once its catalog declares at least two access
 * modes; `catalog` defaults to the last published catalog.
 */

export function providerAccessModeConfig(
  providerId: string | undefined,
  catalog: ProviderAccessCatalog | null = getCatalogProviderMetadata(providerId),
): ProviderAccessModeConfig | null {
  if (!providerId) return null;
  const builtIn = CONFIGS[providerId];
  if (builtIn) return builtIn;
  if (!catalog || catalog.accessModes.length < 2) return null;
  return {
    providerLabel: catalog.label,
    settingKey: providerAccessModeSettingKey(providerId),
  };
}
