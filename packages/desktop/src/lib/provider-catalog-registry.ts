import type {
  RuntimeProviderAccessModeOption,
  RuntimeProviderModeOption,
} from "@/api/agentRuntime";
import { ACCESS_MODES, type AccessMode } from "@/types/access-mode";
import { parsePermissionMode } from "@/types/permission-mode";
import type { ProviderPromptCapabilities, ProviderResumeCommand } from "@/api/generated";

/**
 * Provider-level catalog facts: identity (label, icon) plus the host
 * capabilities the provider declared (modes, access modes, compaction,
 * resume command, prompt capabilities). Model probes are not kept here.
 */

export interface CatalogProviderMetadata {
  label: string;
  iconData: string | null;
  modes: readonly RuntimeProviderModeOption[];
  accessModes: readonly RuntimeProviderAccessModeOption[];
  compactAction: boolean;
  resumeCommand: ProviderResumeCommand | null;
  promptCapabilities: ProviderPromptCapabilities | null;
}

interface CatalogModeInput {
  id: string;
  label: string;
  description?: string | null;
}

/** The subset of a catalog entry the registry reads (generated or runtime type). */
export interface CatalogProviderInput {
  id: string;
  label: string;
  icon_data?: string | null;
  modes?: readonly CatalogModeInput[];
  access_modes?: readonly CatalogModeInput[];
  compact_action?: boolean | null;
  resume_command?: ProviderResumeCommand | null;
  prompt_capabilities?: ProviderPromptCapabilities | null;
}

let providers = new Map<string, CatalogProviderMetadata>();
const listeners = new Map<string, Set<() => void>>();
const catalogListeners = new Set<() => void>();

export function getCatalogProviderMetadata(
  providerId?: string | null,
): CatalogProviderMetadata | null {
  return providerId ? (providers.get(providerId) ?? null) : null;
}

/**
 * Every provider's metadata. The map is replaced on each change, never mutated,
 * so it is a valid `useSyncExternalStore` snapshot for views that read many
 * providers at once.
 */
export function getProviderCatalog(): ReadonlyMap<string, CatalogProviderMetadata> {
  return providers;
}

/** Calls `listener` after any provider's metadata changes. */
export function subscribeProviderCatalogChanges(listener: () => void): () => void {
  catalogListeners.add(listener);
  return () => {
    catalogListeners.delete(listener);
  };
}

export function subscribeProviderCatalog(
  providerId: string | null | undefined,
  listener: () => void,
): () => void {
  if (!providerId) return () => undefined;
  const providerListeners = listeners.get(providerId) ?? new Set();
  providerListeners.add(listener);
  listeners.set(providerId, providerListeners);
  return () => {
    providerListeners.delete(listener);
    if (providerListeners.size === 0) listeners.delete(providerId);
  };
}

/**
 * Publish provider-level metadata from a successful catalog response. Model
 * probes vary by cwd/profile; labels, icons and declared host capabilities do
 * not. Unchanged providers keep their snapshot object.
 */
export function setProviderCatalogMetadata<Entry extends CatalogProviderInput>(
  entries: readonly Entry[],
): void {
  const next = new Map<string, CatalogProviderMetadata>();
  const changedProviderIds: string[] = [];
  for (const entry of entries) {
    const candidate = toMetadata(entry);
    const before = providers.get(entry.id);
    const same = before !== undefined && metadataEqual(before, candidate);
    next.set(entry.id, same ? before : candidate);
    if (!same) changedProviderIds.push(entry.id);
  }
  for (const id of providers.keys()) {
    if (!next.has(id)) changedProviderIds.push(id);
  }
  if (changedProviderIds.length === 0) return;
  providers = next;
  for (const listener of catalogListeners) listener();
  for (const providerId of changedProviderIds) {
    for (const listener of listeners.get(providerId) ?? []) listener();
  }
}

function toMetadata(entry: CatalogProviderInput): CatalogProviderMetadata {
  return {
    label: entry.label,
    iconData: entry.icon_data ?? null,
    modes: (entry.modes ?? []).flatMap(permissionModeOption),
    accessModes: (entry.access_modes ?? []).flatMap(accessModeOption),
    compactAction: entry.compact_action ?? false,
    resumeCommand: entry.resume_command ?? null,
    promptCapabilities: entry.prompt_capabilities ?? null,
  };
}

/** Catalog ids outside the host's permission-mode vocabulary are dropped. */
function permissionModeOption(mode: CatalogModeInput): RuntimeProviderModeOption[] {
  const id = parsePermissionMode(mode.id);
  return id ? [{ id, label: mode.label, description: mode.description ?? undefined }] : [];
}

function accessModeOption(mode: CatalogModeInput): RuntimeProviderAccessModeOption[] {
  if (!(ACCESS_MODES as readonly string[]).includes(mode.id)) return [];
  return [
    { id: mode.id as AccessMode, label: mode.label, description: mode.description ?? undefined },
  ];
}

function metadataEqual(a: CatalogProviderMetadata, b: CatalogProviderMetadata): boolean {
  // Scalars first: `iconData` is a base64 image, too large to serialize per check.
  if (a.label !== b.label || a.iconData !== b.iconData || a.compactAction !== b.compactAction) {
    return false;
  }
  const declared = (metadata: CatalogProviderMetadata) =>
    JSON.stringify([
      metadata.modes,
      metadata.accessModes,
      metadata.resumeCommand,
      metadata.promptCapabilities,
    ]);
  return declared(a) === declared(b);
}
