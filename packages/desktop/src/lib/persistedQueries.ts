import type { Query } from "@tanstack/react-query";

/**
 * Bump when the shape of any persisted query response changes.
 * Included in the localStorage key — bumping invalidates persisted state
 * cleanly without a manual `localStorage.removeItem`.
 */
export const CACHE_VERSION = "v1";

/**
 * URL prefixes for queries that are safe to persist to localStorage.
 *
 * Criteria: small payloads, slow-to-fetch from cold cache, low write-rate.
 * Settings, catalog, and project/feature listings qualify; anything
 * volatile (git state, agent-state) does NOT — see {@link NEVER_PERSIST_PREFIXES}.
 */
const PERSIST_PREFIXES: readonly string[] = [
  "/api/projects",
  "/api/features",
  "/api/workspace/settings",
  "/api/workspace/model-settings",
  "/api/workspace/provider-settings",
  "/api/agent-catalog",
];

/**
 * Match suffixes that may appear after a project id under `/api/projects/{id}`.
 * Used to whitelist per-project settings reads.
 */
const PROJECT_SETTINGS_SUFFIXES: readonly string[] = ["/settings"];

/**
 * Explicit deny-list — must always return `false` even if a broader prefix
 * above would match. The agent-state payload is multi-MB and would blow
 * localStorage; git data is volatile and per-feature.
 */
const NEVER_PERSIST_PREFIXES: readonly string[] = [
  "/api/health",
  // Match any feature-scoped agent-state regardless of `{id}`.
  // Format: `/api/features/{id}/agent-state`.
];

function isExplicitlyForbidden(url: string): boolean {
  if (NEVER_PERSIST_PREFIXES.some((p) => url.startsWith(p))) return true;
  // `/api/features/{id}/agent-state` — agent-state can be megabytes.
  if (/^\/api\/features\/[^/]+\/agent-state(?:[/?]|$)/.test(url)) return true;
  // `/api/features/{id}/subagents` — live statuses, pushed about once a second
  // while agents run; a restored snapshot would show dead agents running.
  if (/^\/api\/features\/[^/]+\/subagents(?:[/?]|$)/.test(url)) return true;
  // Live process state: a restored snapshot would advertise ports for servers
  // that died while the app was closed.
  if (url.startsWith("/api/features/ports")) return true;
  // `/api/git/...` — git state changes outside our control.
  if (url.startsWith("/api/git/")) return true;
  return false;
}

function matchesPersistPrefix(url: string): boolean {
  // Settings and catalog: direct prefix match.
  if (
    PERSIST_PREFIXES.some((p) => url === p || url.startsWith(`${p}?`) || url.startsWith(`${p}/`))
  ) {
    // Special-case `/api/projects/{id}/...` — only the specific suffixes
    // listed in `PROJECT_SETTINGS_SUFFIXES` are persisted. The bare
    // listing (`/api/projects`) and the per-project detail are tiny too,
    // but per-project sub-routes like `/files` or `/git` are not.
    const projectDetailMatch = /^\/api\/projects\/[^/]+(.*)$/.exec(url);
    if (projectDetailMatch) {
      const rest = projectDetailMatch[1] ?? "";
      if (rest === "" || rest.startsWith("?")) return true; // detail
      return PROJECT_SETTINGS_SUFFIXES.some(
        (s) => rest === s || rest.startsWith(`${s}?`) || rest.startsWith(`${s}/`),
      );
    }
    return true;
  }
  return false;
}

/**
 * Predicate for `PersistQueryClientProvider` — return `true` only when the
 * query succeeded AND its URL key matches the safelist AND is not in the
 * explicit deny list.
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
  if (isExplicitlyForbidden(head)) return false;
  return matchesPersistPrefix(head);
}
