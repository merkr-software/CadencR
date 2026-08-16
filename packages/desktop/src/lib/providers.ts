import claudeLogo from "../../assets/providers/claude.png";
import claudeMonoLogo from "../../assets/providers/claude-mono.png";
import codexLogo from "../../assets/providers/codex.png";
import codexMonoLogo from "../../assets/providers/codex-mono.png";
import cursorLogo from "../../assets/providers/cursor.png";
import cursorMonoLogo from "../../assets/providers/cursor-mono.png";
import opencodeLogo from "../../assets/providers/opencode.png";
import opencodeMonoLogo from "../../assets/providers/opencode-mono.png";
import { getCatalogProviderMetadata } from "./provider-catalog-registry";

export const PROVIDER_IDS = {
  CLAUDE_CODE: "claude_code",
  OPENCODE: "opencode",
  CODEX_CLI: "codex_cli",
  CURSOR: "cursor",
} as const;

export type ProviderId = (typeof PROVIDER_IDS)[keyof typeof PROVIDER_IDS];

export const DEFAULT_PROVIDER_ID: ProviderId = PROVIDER_IDS.CLAUDE_CODE;

/**
 * Providers where `/compact` is a session action Cadencr performs rather than a
 * slash command the runtime understands. Every surface that accepts a prompt
 * has to make the same call, so the set lives with the other provider facts.
 */
export const COMPACT_ACTION_PROVIDERS: ReadonlySet<string> = new Set([
  PROVIDER_IDS.OPENCODE,
  PROVIDER_IDS.CODEX_CLI,
  PROVIDER_IDS.CURSOR,
]);

export type ProviderIconVariant = "color" | "mono";

export interface ProviderMetadata {
  id: string;
  label: string;
  iconSrc: string | null;
  isMonochrome: boolean;
}

/** Map provider IDs to their bundled icon assets. */
const PROVIDER_ICONS: Record<ProviderId, string> = {
  [PROVIDER_IDS.CLAUDE_CODE]: claudeLogo,
  [PROVIDER_IDS.CODEX_CLI]: codexLogo,
  [PROVIDER_IDS.OPENCODE]: opencodeLogo,
  [PROVIDER_IDS.CURSOR]: cursorLogo,
};

/** Black-on-transparent silhouettes for compact chrome (sidebar, etc.). */
const PROVIDER_MONO_ICONS: Record<ProviderId, string> = {
  [PROVIDER_IDS.CLAUDE_CODE]: claudeMonoLogo,
  [PROVIDER_IDS.CODEX_CLI]: codexMonoLogo,
  [PROVIDER_IDS.OPENCODE]: opencodeMonoLogo,
  [PROVIDER_IDS.CURSOR]: cursorMonoLogo,
};

/** Canonical display names for known providers (Anthropic-recommended branding). */
const PROVIDER_LABELS: Partial<Record<string, string>> = {
  [PROVIDER_IDS.CLAUDE_CODE]: "Claude",
  [PROVIDER_IDS.OPENCODE]: "OpenCode",
  [PROVIDER_IDS.CODEX_CLI]: "Codex",
  [PROVIDER_IDS.CURSOR]: "Cursor",
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
  const icons = variant === "mono" ? PROVIDER_MONO_ICONS : PROVIDER_ICONS;
  const bundledIcon = icons[providerId as ProviderId];
  return {
    id: providerId,
    label:
      catalogLabel ??
      catalogMetadata?.label ??
      PROVIDER_LABELS[providerId] ??
      formatProviderId(providerId),
    iconSrc:
      bundledIcon ?? catalogMetadata?.iconData ?? PROVIDER_ICONS[providerId as ProviderId] ?? null,
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
