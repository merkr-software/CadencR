import { QueryClient, type InvalidateOptions, type Query } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { CACHE_VERSION } from "./persistedQueries";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
  },
});

/**
 * Invalidate every cached query whose URL key starts with any of the given
 * prefixes.
 *
 * Orval emits per-endpoint query keys keyed by URL string (e.g.
 * `["/api/features", { project_id }]`, `["/api/features/123/plan/progress"]`).
 * React Query's default prefix matching only matches *array* prefixes, so a
 * key like `["/api/features"]` will NOT match `["/api/features/123"]` — the
 * first elements are different strings. This helper bridges that gap by doing
 * a string prefix check on `queryKey[0]`, which is how every orval key is
 * built. Pass an array to fold several prefixes into a single cache walk
 * (e.g. on a file-tree change, refresh editor + git stats together).
 */
export function urlPrefixPredicate(
  urlPrefix: string | readonly string[],
): (query: Query) => boolean {
  const prefixes = typeof urlPrefix === "string" ? [urlPrefix] : urlPrefix;
  return (query) => {
    const head = query.queryKey[0];
    if (typeof head !== "string") return false;
    return prefixes.some((p) => head.startsWith(p));
  };
}

export function invalidateByUrlPrefix(
  client: QueryClient,
  urlPrefix: string | readonly string[],
): Promise<void> {
  return client.invalidateQueries({ predicate: urlPrefixPredicate(urlPrefix) });
}

/**
 * Invalidate every cached query whose URL key is exactly `url` (any params).
 * Unlike {@link invalidateByUrlPrefix}, this does NOT match longer sibling
 * URLs — `/api/editor/tree` won't match `/api/editor/tree-all`. Pass an array
 * to refresh several exact sibling endpoints in one cache walk.
 */
export function invalidateByExactUrl(
  client: QueryClient,
  url: string | readonly string[],
  options?: InvalidateOptions,
): Promise<void> {
  const urls = typeof url === "string" ? new Set([url]) : new Set(url);
  return client.invalidateQueries(
    {
      predicate: (query) => {
        const head = query.queryKey[0];
        return typeof head === "string" && urls.has(head);
      },
    },
    options,
  );
}

/**
 * Run once the persisted cache is restored. Restored entries are placeholders
 * from a past run: push events emitted while the app was closed never reached
 * them, and a `staleTime: Infinity` query would otherwise keep them forever
 * (the persister re-stamps its 24 h max age on every write, so age is no
 * guard). Invalidating keeps them on screen while each one refetches as soon
 * as it is observed.
 */
export function revalidateRestoredQueries(): Promise<void> {
  return queryClient.invalidateQueries();
}

/**
 * localStorage persister used by `PersistQueryClientProvider` in `App.tsx`.
 *
 * Only queries that pass `shouldDehydrateQuery` (see `persistedQueries.ts`)
 * are written; the safelist keeps total bytes well under the 5 MB browser
 * quota. The cache key embeds {@link CACHE_VERSION} so a shape change can
 * be rolled out by bumping the version.
 *
 * `throttleTime: 1000` coalesces bursts of cache writes (e.g. typing a
 * settings field) into one localStorage write per second.
 */
export const persister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: `cadencr-rq-cache-${CACHE_VERSION}`,
  throttleTime: 1000,
});
