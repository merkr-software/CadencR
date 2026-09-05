import { DEFAULT_PROVIDER_ID } from "@/lib/providers";

export const DEFAULT_PROVIDER = DEFAULT_PROVIDER_ID;

// `session` drives the ws-session agent. Legacy ws-feature agent settings were
// removed with the workflow stack. `auto_name` is workspace-only and powers the
// auto-rename feature.
export const AGENT_TYPES = ["session", "auto_name"] as const;
export type AgentTypeSetting = (typeof AGENT_TYPES)[number];

export interface CatalogProviderLike {
  id: string;
  status?: string;
  default_model?: string | null;
}

/**
 * Frontend-facing shape of a runtime selection. The backend is the only place
 * that resolves one — see `ResolvedSelection` in the generated API client.
 * This type exists to keep camelCase naming inside the store and components.
 */
export interface RuntimeSelection {
  providerId: string;
  modelId: string;
}

export function availableCatalogProviders<T extends CatalogProviderLike>(
  providers: readonly T[] | undefined,
): T[] {
  return (providers ?? []).filter(
    (provider) => provider.status == null || provider.status === "available",
  );
}

const PHASE_MODEL_KEY_PREFIX = "model_phase_";
export function phaseModelKey(slug: string): string {
  return `${PHASE_MODEL_KEY_PREFIX}${slug}`;
}
