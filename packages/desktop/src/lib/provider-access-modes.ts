import type { RuntimeProviderAccessModeOption } from "@/api/agentRuntime";
import type { UiTranslator } from "@/lib/i18n/ui";
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

/**
 * Localize the bundled Codex catalog copy. Match each original phrase so a service
 * with changed, absent, or already localized metadata keeps its own wording.
 */
export function displayProviderAccessMode(
  providerId: string | undefined,
  option: RuntimeProviderAccessModeOption,
  t: UiTranslator,
): RuntimeProviderAccessModeOption {
  if (providerId !== PROVIDER_IDS.CODEX_CLI) return option;
  switch (option.id) {
    case "default":
      return {
        ...option,
        label:
          option.label === "Default"
            ? t("settings.providers.accessMode.codex.default.label", "Default")
            : option.label,
        description:
          option.description ===
          "Runs in the workspace-write sandbox. Codex asks you to review command, network, or file access when approval is needed."
            ? t(
                "settings.providers.accessMode.codex.default.description",
                "Runs in the workspace-write sandbox. Codex asks you to review command, network, or file access when approval is needed.",
              )
            : option.description,
      };
    case "fullAccess":
      return {
        ...option,
        label:
          option.label === "Full Access"
            ? t("settings.providers.accessMode.codex.fullAccess.label", "Full Access")
            : option.label,
        description:
          option.description ===
          "Disables sandboxing and approval prompts. Codex can run commands and access files or network without asking first."
            ? t(
                "settings.providers.accessMode.codex.fullAccess.description",
                "Disables sandboxing and approval prompts. Codex can run commands and access files or network without asking first.",
              )
            : option.description,
      };
    case "autoReview":
      return {
        ...option,
        label:
          option.label === "Auto Review"
            ? t("settings.providers.accessMode.codex.autoReview.label", "Auto Review")
            : option.label,
        description:
          option.description ===
          "Keeps the workspace-write sandbox, but lets Codex automatically review approval requests instead of routing each one to you."
            ? t(
                "settings.providers.accessMode.codex.autoReview.description",
                "Keeps the workspace-write sandbox, but lets Codex automatically review approval requests instead of routing each one to you.",
              )
            : option.description,
      };
    default:
      return option;
  }
}
