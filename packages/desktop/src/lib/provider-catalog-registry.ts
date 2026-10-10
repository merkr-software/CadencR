import type { ProviderCatalogResponseEntry } from "@/api/generated";

export interface CatalogProviderMetadata {
  label: string;
  iconData: string | null;
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

/** Calls `listener` after any provider's label or icon changes. */
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
 * Publish only provider identity metadata from a successful catalog response.
 * Model probes vary by cwd/profile; labels and package-owned icons do not.
 */
export function setProviderCatalogMetadata(entries: ProviderCatalogResponseEntry[]): void {
  const next = new Map(
    entries.map((entry) => [
      entry.id,
      { label: entry.label, iconData: entry.icon_data ?? null } satisfies CatalogProviderMetadata,
    ]),
  );
  const changedProviderIds = changedProviders(providers, next);
  if (changedProviderIds.length === 0) return;
  providers = next;
  for (const listener of catalogListeners) listener();
  for (const providerId of changedProviderIds) {
    for (const listener of listeners.get(providerId) ?? []) listener();
  }
}

function changedProviders(
  current: ReadonlyMap<string, CatalogProviderMetadata>,
  next: ReadonlyMap<string, CatalogProviderMetadata>,
): string[] {
  const ids = new Set([...current.keys(), ...next.keys()]);
  const changed: string[] = [];
  for (const id of ids) {
    const before = current.get(id);
    const after = next.get(id);
    if (before?.label !== after?.label || before?.iconData !== after?.iconData) changed.push(id);
  }
  return changed;
}
