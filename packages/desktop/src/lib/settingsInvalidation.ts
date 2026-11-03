import type { QueryClient } from "@tanstack/react-query";
import { urlPrefixPredicate } from "./queryClient";
import { createLeadingSettleCoalescer } from "./coalesceInvalidation";

// Workspace settings endpoints whose URL head is a stable prefix (no dynamic
// id). Matched via the shared orval-key prefix helper so the "how orval keys
// work" knowledge stays in one place.
const matchesWorkspaceSettingsUrl = urlPrefixPredicate([
  "/api/workspace/settings",
  "/api/workspace/model-settings",
  "/api/workspace/provider-settings",
  // Resolved from settings, including the last-used pair a prompt records.
  "/api/agent-runtime/selection",
  "/api/lsp/resolve",
  "/api/lsp/servers",
]);

/**
 * Invalidate every query whose data derives from the settings JSON files —
 * not just the raw `settings` endpoints.
 *
 * Settings drive model selection, provider selection, and the agent catalog
 * (its default model/provider depend on the active Claude profile, which is a
 * setting). So a JSON edit — whether our own save or an external edit picked up
 * by the file watcher — must refresh those derived caches too, or the model
 * picker and provider toggles keep showing stale values.
 *
 * This deliberately spans two query-key shapes:
 *  - orval URL-string keys (`/api/.../settings`, `/api/.../model-settings`,
 *    `/api/.../provider-settings`), matched on the URL head; and
 *  - the hand-written custom keys in `api/agentRuntime.ts`
 *    (`["workspace"|"features", "provider-settings", …]`,
 *    `["agent-catalog", …]`), matched structurally.
 *
 * Settings changes are rare and user-driven, so a slightly broad refetch here
 * is the right trade — correctness over shaving a few cache walks.
 */
/**
 * Coalesce bursts of settings invalidations into a leading refetch plus one
 * trailing refetch — the same leading+settle shape as `scheduleGitInvalidation`
 * (this variant is keyless and doesn't re-arm, since settings events are rare).
 *
 * A single settings save fans out into several `settings_event`s in quick
 * succession: our own atomic write, the file watcher's echo, and any sibling
 * `*.settings.json` touched by the cascade. Each event invalidates the
 * `agent-catalog` + provider/model caches, and those are mounted on hot paths
 * (every open session's composer and resolved-model context). Invalidating
 * once per raw event triggers a refetch + re-render wave per event; coalescing
 * collapses the burst so the wave fires at most twice per settling window.
 */
const SETTINGS_INVALIDATION_SETTLE_MS = 400;

const settingsCoalescer = createLeadingSettleCoalescer<QueryClient>(
  invalidateSettingsDerivedQueries,
  SETTINGS_INVALIDATION_SETTLE_MS,
);

export function scheduleSettingsInvalidation(client: QueryClient): void {
  settingsCoalescer.trigger(client);
}

export function invalidateSettingsDerivedQueries(client: QueryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) => {
      if (matchesWorkspaceSettingsUrl(query)) return true;

      const head = query.queryKey[0];
      const sub = query.queryKey[1];
      if (typeof head !== "string") return false;

      // Hand-written custom keys whose data depends on settings.
      if (head === "agent-catalog") return true;
      if (sub === "provider-settings" && (head === "workspace" || head === "features")) {
        return true;
      }

      // Project/feature settings endpoints carry a dynamic id in the URL head,
      // so a plain prefix can't match — key off the id-agnostic path segment.
      return (
        (head.startsWith("/api/projects/") && head.includes("/settings")) ||
        (head.startsWith("/api/features/") &&
          (head.includes("/model-settings") || head.includes("/provider-settings")))
      );
    },
  });
}
