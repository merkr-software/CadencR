/** App-envelope presentation effects and backend-confirmed status notifications. */
import { invalidateByExactUrl, invalidateByUrlPrefix, queryClient } from "@/lib/queryClient";
import { createLeadingSettleCoalescer } from "@/lib/coalesceInvalidation";
import { invalidateChangedDocuments } from "@/lib/document-file";
import { scheduleSettingsInvalidation } from "@/lib/settingsInvalidation";
import { scheduleThemeInvalidation } from "@/lib/themeInvalidation";
import { handlePluginTabChanged } from "@/lib/plugin-tabs/live-instances";
import {
  getAlacrittyConfigRouteQueryKey,
  getListFeaturesQueryKey,
  type Feature,
} from "@/api/generated";
import { invalidateScheduleLists } from "@/lib/schedules/invalidate";
import { invalidatePromptQueue } from "@/lib/prompt-queue";
import { applyCustomActionEvent } from "@/lib/custom-actions/events";
import { GLOBAL_FEATURE_LIST_URLS, invalidateFeatureQueries } from "@/lib/featureUpdated";
import { isViewingFeature, notifyAgentDone, notifyAgentNeedsInput } from "@/lib/notify-agent-done";
import { openingClearsForMe } from "@/stores/for-me-ack";
import { useUnreadStore } from "@/stores/unread-store";
import { handleGitEnvelope } from "@/stores/ws-git-status-handler";
import { showRemoteConnectedToast } from "@/lib/remote/connection-toast";
import { handleAgentArchived } from "@/lib/agent-archived";
import { applyStorageMaintenanceEvent } from "@/stores/storage-maintenance-store";
import { applyProviderUpdatesEvent } from "@/stores/provider-updates";
import { applyRestartContinuationsEvent } from "@/stores/restart-continuations";
import type { LiveAgentStatus } from "@/types/agent";

function isFeatureList(data: Feature[] | object | undefined): data is Feature[] {
  return Array.isArray(data);
}

/** A feature's record from any loaded project list, without a request. */
export function lookupFeature(featureId: number): Feature | undefined {
  // Prefix-match all per-project listFeatures caches via the orval-generated key.
  // Other per-feature queries share the prefix (a pending gate is
  // `["/api/features", id, "pending-gate", …]`): only lists hold features.
  const queries = queryClient.getQueriesData<Feature[] | object>({
    queryKey: getListFeaturesQueryKey(),
  });
  for (const [, data] of queries) {
    if (!isFeatureList(data)) continue;
    const feature = data.find((f) => f.id === featureId);
    if (feature) return feature;
  }
  return undefined;
}

export function notifyTransition(
  featureId: number,
  prevStatus: LiveAgentStatus | undefined,
  nextStatus: LiveAgentStatus,
  failed = false,
): void {
  const endedTurn = nextStatus === "idle" && (failed || prevStatus === "agent");
  markUnseenOutcome(featureId, nextStatus, endedTurn, failed);
  const feature = lookupFeature(featureId);
  if (!feature) return;
  const opts = {
    featureTitle: feature.title,
    featureId,
    projectId: feature.project_id,
    routeType: "session" as const,
  };
  if (nextStatus === "question" && prevStatus !== "question") {
    notifyAgentNeedsInput(opts);
  } else if (endedTurn) {
    notifyAgentDone({ ...opts, status: failed ? "error" : "completed" });
  }
}

/**
 * Flag a turn that ended while the user wasn't looking: unread when it
 * completed, failed when it stopped on an error. (If they're already viewing
 * it, there's nothing unseen, unless For me clears only when done: then the
 * outcome waits in For me until marked done, viewed or not.) Independent of
 * the feature lists, so a collapsed project's conversations are flagged too.
 */
function markUnseenOutcome(
  featureId: number,
  nextStatus: LiveAgentStatus,
  endedTurn: boolean,
  failed: boolean,
): void {
  const marks = useUnreadStore.getState();
  if (nextStatus === "agent") {
    marks.clearFailed(featureId);
    return;
  }
  if (!endedTurn || (isViewingFeature(featureId) && openingClearsForMe())) return;
  if (failed) marks.markFailed(featureId);
  else marks.markUnread(featureId);
}

/**
 * Editor caches to refresh when the file tree changes on disk. Must exceed the
 * backend watcher's 1s min-emit gap so consecutive emissions during sustained
 * churn land in the same settle window and collapse into one trailing refetch.
 */
const EDITOR_INVALIDATION_SETTLE_MS = 1_200;
// Keep `/api/editor/tree-count` out of the wave: the full/lazy-mode decision
// is made on mount and is not re-evaluated mid-session. Content and tree data
// still refresh so open tabs and the active tree stay current during agent work.
const EDITOR_INVALIDATION_EXACT_URLS = [
  "/api/editor/read",
  "/api/editor/read-image",
  "/api/editor/tree",
  "/api/editor/tree-all",
  "/api/editor/search",
] as const;

const editorInvalidationCoalescer = createLeadingSettleCoalescer(
  () => invalidateByExactUrl(queryClient, EDITOR_INVALIDATION_EXACT_URLS),
  EDITOR_INVALIDATION_SETTLE_MS,
);

function scheduleEditorInvalidation(): void {
  editorInvalidationCoalescer.trigger();
}

/** Test-only: cancel the pending trailing timer between cases. */
export function resetEditorInvalidationSchedulingForTest(): void {
  editorInvalidationCoalescer.reset();
}

/**
 * Route a non-status app envelope (file-tree invalidation, git events).
 * The session-status reducers are dispatched separately by the store.
 */
export function handleAppEnvelope(
  domain: string,
  action: string,
  payload: Record<string, unknown>,
): boolean {
  if (domain === "editor" && action === "file_tree.changed") {
    // Coalesced (leading + settle): a build or agent writing files fires a
    // burst of these, and each one otherwise refetches editor read/tree/search
    // and re-renders. The backend watcher already caps emissions to ~1/sec;
    // this collapses the burst on the client to at most two refetch waves.
    //
    // Git diff/stats are deliberately NOT invalidated here: the git watcher
    // drives those via its own coalesced `git.status` path
    // (`ws-git-status-handler.ts`). Refetching the unbounded git diff on every
    // file-tree change was a second, unprotected route to the exact storm that
    // path already guards against.
    scheduleEditorInvalidation();
    // Document previews refetch only for the documents the event names.
    invalidateChangedDocuments(queryClient, payload);
    return true;
  }
  if (domain === "git") {
    handleGitEnvelope(action, payload);
    return true;
  }
  if (domain === "app" && action === "agent_archived") {
    handleAgentArchived(payload);
    return true;
  }
  if (domain === "app" && action === "remote_connected") {
    showRemoteConnectedToast();
    return true;
  }
  if (domain === "app" && action === "provider_updates") {
    applyProviderUpdatesEvent(payload);
    return true;
  }
  if (domain === "app" && action === "restart_continuations") {
    applyRestartContinuationsEvent(payload);
    return true;
  }
  if (domain === "app" && action === "storage_maintenance") {
    applyStorageMaintenanceEvent(payload);
    return true;
  }
  if (domain === "app" && action === "settings_event") {
    // A settings JSON file changed on disk (our own write or an external edit).
    // Refetch every settings-derived query — not just the raw settings
    // endpoints but the model/provider/agent-catalog caches that resolve
    // through the settings cascade — so the UI and warnings banners reflect the
    // new file. Coalesced: one save fans out into several events (our write,
    // the watcher echo, sibling settings files), and each refetch triggers a
    // re-render wave across every mounted ModelSelector/session composer.
    scheduleSettingsInvalidation(queryClient);
    return true;
  }

  if (domain === "app" && action === "schedule_event") {
    // A schedule ran: its `next_run_at`, run count and last-run badge all moved
    // server-side, and nothing this client did says so. The conversation lists
    // are deliberately left alone — a run that spawned one emits `Created` and
    // a run into an existing one emits `Reordered`, both handled below.
    invalidateScheduleLists(queryClient);
    return true;
  }
  if (domain === "app" && action === "theme_event") {
    // A user theme's `theme.json` changed on disk. Leading-edge so the live
    // preview updates on the first event — a delay here reads as "my edit
    // didn't take" — plus a trailing refetch so a burst (an editor saving on
    // every keystroke) settles on the final content without one full
    // re-read-and-revalidate of every theme file per keystroke.
    // The same file holds the label the theme's project is named after, so the
    // sidebar's list is refetched with it.
    scheduleThemeInvalidation(queryClient, typeof payload.id === "string" ? payload.id : undefined);
    return true;
  }
  if (domain === "app" && action === "prompt_queue_changed") {
    // Bare ping ({session_id}, or nothing after a lagged stream): re-fetch.
    invalidatePromptQueue(typeof payload.session_id === "number" ? payload.session_id : undefined);
    return true;
  }
  if (domain === "app" && action === "custom_action_event") {
    applyCustomActionEvent(queryClient, payload);
    return true;
  }
  if (domain === "app" && action === "plugin_tab_changed") {
    handlePluginTabChanged(payload);
    return true;
  }
  if (domain === "app" && action === "alacritty_config_event") {
    // `~/.config/alacritty/alacritty.toml` changed on disk. The envelope
    // carries no payload — same "ping, then re-fetch" convention as
    // settings_event — so this just invalidates the one query that reads it;
    // `useTerminalOptions` re-resolves from the refetched response.
    void queryClient.invalidateQueries({ queryKey: getAlacrittyConfigRouteQueryKey() });
    return true;
  }
  if (domain === "app" && action === "feature_event") {
    // A feature changed (possibly on another device). An "updated" event (e.g.
    // auto-name) also changed a title, so refresh the individual feature — an
    // open conversation header falls back to the REST title when this device
    // has no live WS title — via the shared invalidation helper. "reordered"
    // (a new user message changed the most-recent-user-message sort key) only
    // reshuffles its own project's list, so it's scoped to that project.
    // create/delete reshape the lists too, but a created feature isn't cached
    // yet, so they fall back to invalidating every project's list. The
    // single-feature refetch (a guaranteed 404 after a delete) is skipped for
    // all but "updated".
    const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;
    if (payload.action === "updated" && featureId != null) {
      invalidateFeatureQueries(featureId, ["title"]);
    } else if (payload.action === "reordered" && featureId != null) {
      const projectId = lookupFeature(featureId)?.project_id;
      void queryClient.invalidateQueries({
        queryKey:
          projectId != null
            ? getListFeaturesQueryKey({ project_id: projectId })
            : getListFeaturesQueryKey(),
      });
    } else {
      void queryClient.invalidateQueries({ queryKey: getListFeaturesQueryKey() });
    }
    // The cross-project lists (Pinned, Recent, lenses) are keyed by sibling URLs
    // that the `["/api/features"]` array-prefix above can't reach (React Query
    // only prefix-matches array elements). Refresh them explicitly so a pin, a
    // rename or a delete on any device keeps them in sync.
    void invalidateByUrlPrefix(queryClient, GLOBAL_FEATURE_LIST_URLS);
    return true;
  }
  return false;
}
