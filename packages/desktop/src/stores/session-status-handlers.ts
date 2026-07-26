/**
 * Pure helpers + envelope-routing for `session-status-store`.
 *
 * Extracted to keep the store file under the 400-line limit. The store
 * still owns the WebSocket lifecycle and Zustand wiring; this file holds
 * the snapshot/update reducers, value validators, feature-lookup, and
 * notification trigger that the store imports.
 */
import { invalidateByExactUrl, invalidateByUrlPrefix, queryClient } from "@/lib/queryClient";
import { createLeadingSettleCoalescer } from "@/lib/coalesceInvalidation";
import { scheduleSettingsInvalidation } from "@/lib/settingsInvalidation";
import { getListFeaturesQueryKey, type Feature } from "@/api/generated";
import { invalidateScheduleLists } from "@/lib/schedules/invalidate";
import { invalidateFeatureQueries } from "@/lib/featureUpdated";
import { isViewingFeature, notifyAgentDone, notifyAgentNeedsInput } from "@/lib/notify-agent-done";
import { useUnreadStore } from "@/stores/unread-store";
import { handleGitEnvelope } from "@/stores/ws-git-status-handler";
import { showRemoteConnectedToast } from "@/lib/remote/connection-toast";
import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import type { SessionStatusEntry } from "@/stores/session-status-store";

const STATUS_VALUES: LiveAgentStatus[] = ["idle", "agent", "question"];
const PENDING_KIND_VALUES: PendingKind[] = ["permission", "question"];

export function isStatus(val: unknown): val is LiveAgentStatus {
  return typeof val === "string" && (STATUS_VALUES as string[]).includes(val);
}

export function isPendingKind(val: unknown): val is PendingKind {
  return typeof val === "string" && (PENDING_KIND_VALUES as string[]).includes(val);
}

function lookupFeature(featureId: number): Feature | undefined {
  // Prefix-match all per-project listFeatures caches via the orval-generated key.
  const queries = queryClient.getQueriesData<Feature[]>({ queryKey: getListFeaturesQueryKey() });
  for (const [, data] of queries) {
    const feature = data?.find((f) => f.id === featureId);
    if (feature) return feature;
  }
  return undefined;
}

export function notifyTransition(
  featureId: number,
  prevStatus: LiveAgentStatus | undefined,
  nextStatus: LiveAgentStatus,
): void {
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
  } else if (nextStatus === "idle" && prevStatus === "agent") {
    notifyAgentDone({ ...opts, status: "completed" });
    // The agent finished while the user wasn't looking — flag the sidebar row
    // unread. (If they're already viewing it, there's nothing unread.)
    if (!isViewingFeature(featureId)) {
      useUnreadStore.getState().markUnread(featureId);
    }
  }
}

/**
 * Apply a `session_status.snapshot` envelope to the per-session map. Pure
 * over `prev` — see store comments for the seq-merge invariants.
 */
export function applySnapshot(
  prev: Record<number, SessionStatusEntry>,
  payload: Record<string, unknown>,
): Record<number, SessionStatusEntry> {
  const rawStates = (payload.states ?? {}) as Record<string, unknown>;
  const snapshotSeq = typeof payload.seq === "number" ? payload.seq : 0;
  const next: Record<number, SessionStatusEntry> = {};

  for (const [idKey, entryRaw] of Object.entries(rawStates)) {
    const sessionId = Number(idKey);
    if (!Number.isFinite(sessionId)) continue;
    if (!entryRaw || typeof entryRaw !== "object") continue;
    const obj = entryRaw as Record<string, unknown>;
    const featureId = typeof obj.feature_id === "number" ? obj.feature_id : null;
    if (featureId == null) continue;
    const status = isStatus(obj.status) ? obj.status : null;
    if (!status) continue;
    const kind = isPendingKind(obj.kind) ? obj.kind : null;
    const requestId = typeof obj.request_id === "string" ? obj.request_id : null;
    const turnStartedAtMs =
      typeof obj.turn_started_at_ms === "number" ? obj.turn_started_at_ms : null;

    // Preserve a more recent live entry if it has overtaken the snapshot.
    const existing = prev[sessionId];
    if (existing && existing.seq > snapshotSeq) {
      next[sessionId] = existing;
      continue;
    }
    next[sessionId] = {
      status,
      kind,
      requestId,
      featureId,
      seq: snapshotSeq,
      turnStartedAtMs,
    };

    if (status === "question" && existing?.status !== "question") {
      notifyTransition(featureId, existing?.status, status);
    }
  }

  // Carry over live entries with seq > snapshotSeq that the snapshot
  // didn't include (the backend filters Idle entries from snapshots, so
  // a live "agent" event arriving just before the snapshot must be
  // preserved here).
  for (const [idKey, entry] of Object.entries(prev)) {
    const sessionId = Number(idKey);
    if (!Number.isFinite(sessionId)) continue;
    if (sessionId in next) continue;
    if (entry.seq > snapshotSeq) {
      next[sessionId] = entry;
    }
  }

  return next;
}

/**
 * Apply a `session_status.update` envelope. Returns the patched map plus
 * the prev/next status pair so the caller can fire native notifications.
 */
export function applyUpdate(
  prev: Record<number, SessionStatusEntry>,
  payload: Record<string, unknown>,
): {
  next: Record<number, SessionStatusEntry> | null;
  sessionId: number | null;
  featureId: number | null;
  prevStatus: LiveAgentStatus | undefined;
  nextStatus: LiveAgentStatus | null;
  entry: Pick<SessionStatusEntry, "status" | "kind" | "requestId" | "turnStartedAtMs"> | null;
} {
  const sessionId = typeof payload.session_id === "number" ? payload.session_id : null;
  const featureId = typeof payload.feature_id === "number" ? payload.feature_id : null;
  const seq = typeof payload.seq === "number" ? payload.seq : 0;
  const turnStartedAtMs =
    typeof payload.turn_started_at_ms === "number" ? payload.turn_started_at_ms : null;
  if (sessionId == null || featureId == null) {
    return {
      next: null,
      sessionId: null,
      featureId: null,
      prevStatus: undefined,
      nextStatus: null,
      entry: null,
    };
  }
  if (!isStatus(payload.status)) {
    return {
      next: null,
      sessionId,
      featureId,
      prevStatus: undefined,
      nextStatus: null,
      entry: null,
    };
  }
  const kind = isPendingKind(payload.kind) ? payload.kind : null;
  const requestId = typeof payload.request_id === "string" ? payload.request_id : null;

  const existing = prev[sessionId];
  if (existing && seq <= existing.seq) {
    // Out-of-order — drop.
    return {
      next: null,
      sessionId,
      featureId,
      prevStatus: existing.status,
      nextStatus: null,
      entry: null,
    };
  }

  const sameValue =
    existing?.status === payload.status &&
    (existing?.kind ?? null) === kind &&
    (existing?.requestId ?? null) === requestId &&
    existing?.featureId === featureId;

  if (sameValue) {
    // Skipping the `set` keeps every selector subscribed to `bySession`
    // referentially stable through the long Agent-streaming runs.
    return {
      next: null,
      sessionId,
      featureId,
      prevStatus: existing.status,
      nextStatus: payload.status,
      entry: { status: payload.status, kind, requestId, turnStartedAtMs },
    };
  }

  return {
    next: {
      ...prev,
      [sessionId]: {
        status: payload.status,
        kind,
        requestId,
        featureId,
        seq,
        turnStartedAtMs,
      },
    },
    sessionId,
    featureId,
    prevStatus: existing?.status,
    nextStatus: payload.status,
    entry: { status: payload.status, kind, requestId, turnStartedAtMs },
  };
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
    return true;
  }
  if (domain === "git") {
    handleGitEnvelope(action, payload);
    return true;
  }
  if (domain === "app" && action === "remote_connected") {
    showRemoteConnectedToast();
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
    // The global "Pinned" sidebar section is keyed by `/api/features/pinned`,
    // a sibling URL that the `["/api/features"]` array-prefix above can't reach
    // (React Query only prefix-matches array elements). Refresh it explicitly
    // so a pin/unpin (or a delete of a pinned conversation) on any device keeps
    // the section in sync.
    void invalidateByUrlPrefix(queryClient, "/api/features/pinned");
    return true;
  }
  return false;
}
