import { useCallback, useSyncExternalStore } from "react";
import {
  getCatalogProviderMetadata,
  subscribeProviderCatalog,
  type CatalogProviderMetadata,
} from "@/lib/provider-catalog-registry";

/**
 * One provider's catalog metadata (identity + declared host capabilities),
 * re-rendering only when that provider's entry changes. `null` until a
 * catalog response has listed the provider.
 */
export function useCatalogProviderMetadata(
  providerId: string | null | undefined,
): CatalogProviderMetadata | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeProviderCatalog(providerId, listener),
    [providerId],
  );
  const snapshot = useCallback(() => getCatalogProviderMetadata(providerId), [providerId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
