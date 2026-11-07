import type { Query } from "@tanstack/react-query";

/**
 * Bump when the shape of any persisted query response changes.
 * Included in the localStorage key — bumping invalidates persisted state
 * cleanly without a manual `localStorage.removeItem`.
 */
export const CACHE_VERSION = "v1";

/**
 * Exact routes (any params) whose responses are safe to persist to
 * localStorage. An allowlist, not a prefix: a new sibling route is never
 * persisted by accident.
 *
 * Criteria: small payloads, slow-to-fetch from cold cache, low write-rate.
 * Live state (statuses, active/activity lists, pending gates, ports, git,
 * agent-state, subagents) never qualifies: a restored snapshot would show
 * agents and servers that died while the app was closed. Restored entries
 * are placeholders anyway — `App.tsx` revalidates them all once restored.
 */
const ID = "[^/?]+";
const PERSISTED_ROUTES: readonly RegExp[] = [
  "/api/projects",
  `/api/projects/${ID}`,
  `/api/projects/${ID}/settings`,
  "/api/features",
  "/api/features/pinned",
  "/api/features/recent",
  `/api/features/${ID}`,
  `/api/features/${ID}/settings`,
  `/api/features/${ID}/model-settings`,
  `/api/features/${ID}/provider-settings`,
  `/api/features/${ID}/row-summary`,
  "/api/workspace/settings",
  `/api/workspace/settings/${ID}`,
  "/api/workspace/model-settings",
  "/api/workspace/provider-settings",
  "/api/agent-catalog",
].map((route) => new RegExp(`^${route}(?:\\?.*)?$`));

/** Live routes that share a shape with a persisted `/api/features/{id}` detail. */
const LIVE_FEATURE_ROUTES: ReadonlySet<string> = new Set([
  "/api/features/active",
  "/api/features/activity",
  "/api/features/ports",
]);

function isPersistedRoute(url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  if (LIVE_FEATURE_ROUTES.has(path)) return false;
  return PERSISTED_ROUTES.some((route) => route.test(url));
}

/**
 * Predicate for `PersistQueryClientProvider` — return `true` only when the
 * query succeeded AND its URL key is one of {@link PERSISTED_ROUTES}.
 *
 * Orval keys URL strings as `queryKey[0]`, so a string prefix check is all
 * we need.
 */
export function shouldDehydrateQuery(query: Query): boolean {
  if (query.state.status !== "success") return false;
  // Bytes serialize to `{}`: a restored image query would hand `{}` to
  // `URL.createObjectURL` and throw on the next launch.
  if (query.state.data instanceof Blob) return false;
  const head = query.queryKey[0];
  if (typeof head !== "string") return false;
  return isPersistedRoute(head);
}
