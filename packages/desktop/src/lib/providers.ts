import claudeLogo from "../../assets/providers/claude.png";
import claudeMonoLogo from "../../assets/providers/claude-mono.png";
import codexLogo from "../../assets/providers/codex.png";
import codexMonoLogo from "../../assets/providers/codex-mono.png";
import opencodeLogo from "../../assets/providers/opencode.png";
import opencodeMonoLogo from "../../assets/providers/opencode-mono.png";
import { getCatalogProviderMetadata } from "./provider-catalog-registry";

export const PROVIDER_IDS = {
  CLAUDE_CODE: "claude_code",
  OPENCODE: "opencode",
  CODEX_CLI: "codex_cli",
} as const;

export type ProviderId = (typeof PROVIDER_IDS)[keyof typeof PROVIDER_IDS];

export const DEFAULT_PROVIDER_ID: ProviderId = PROVIDER_IDS.CLAUDE_CODE;

export type ProviderIconVariant = "color" | "mono";

export interface ProviderMetadata {
  id: string;
  label: string;
  iconSrc: string | null;
  isMonochrome: boolean;
  /** Alpha-bounds compensation for bundled compact silhouettes. */
  monoIconScale?: number;
}

/** Map provider IDs to their bundled icon assets. */
const PROVIDER_ICONS: Record<ProviderId, string> = {
  [PROVIDER_IDS.CLAUDE_CODE]: claudeLogo,
  [PROVIDER_IDS.CODEX_CLI]: codexLogo,
  [PROVIDER_IDS.OPENCODE]: opencodeLogo,
};

/** Bundled silhouettes with scale compensation for their transparent 64px canvases. */
const PROVIDER_MONO_ICONS: Record<ProviderId, { src: string; scale: number }> = {
  [PROVIDER_IDS.CLAUDE_CODE]: { src: claudeMonoLogo, scale: 64 / 56 },
  [PROVIDER_IDS.CODEX_CLI]: { src: codexMonoLogo, scale: 64 / 43 },
  [PROVIDER_IDS.OPENCODE]: { src: opencodeMonoLogo, scale: 64 / 46 },
};

/** Canonical display names for known providers (Anthropic-recommended branding). */
const PROVIDER_LABELS: Partial<Record<string, string>> = {
  [PROVIDER_IDS.CLAUDE_CODE]: "Claude",
  [PROVIDER_IDS.OPENCODE]: "OpenCode",
  [PROVIDER_IDS.CODEX_CLI]: "Codex",
};

/**
 * Get provider metadata. Built-ins use bundled assets; installed providers use
 * the connector-owned icon supplied by the runtime catalog. Labels fall back
 * from catalog data to the canonical built-in map, then to the provider ID.
 */
export function getProviderMetadata(
  providerId?: string | null,
  catalogLabel?: string | null,
  variant: ProviderIconVariant = "color",
  catalogMetadata = getCatalogProviderMetadata(providerId),
): ProviderMetadata | null {
  if (!providerId) {
    return null;
  }
  const monoIcon = variant === "mono" ? PROVIDER_MONO_ICONS[providerId as ProviderId] : undefined;
  const bundledIcon = variant === "mono" ? monoIcon?.src : PROVIDER_ICONS[providerId as ProviderId];
  return {
    id: providerId,
    label:
      catalogLabel ??
      catalogMetadata?.label ??
      PROVIDER_LABELS[providerId] ??
      formatProviderId(providerId),
    iconSrc:
      bundledIcon ?? catalogMetadata?.iconData ?? PROVIDER_ICONS[providerId as ProviderId] ?? null,
    monoIconScale: monoIcon?.scale,
    isMonochrome: variant === "mono" && bundledIcon != null,
  };
}

/** Convert a snake_case provider ID to a human-readable label. */
function formatProviderId(id: string): string {
  return id
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function isDefaultProvider(providerId?: string | null): boolean {
  return providerId === DEFAULT_PROVIDER_ID;
}
