/** Application composition between backend status, conversations, and presentation. */
import { noteUserPrompt } from "@/lib/auto-layout/auto-layout-controller";
import { revealAgentDocument } from "@/lib/auto-layout/agent-document-activity";
import { serverToLocalMs } from "@/lib/server-clock";
import { acknowledgeForMe } from "@/stores/for-me-ack";
import { handleAppSocketError } from "@/stores/app-socket-errors";
import { reconcileQuestionDrafts } from "@/stores/question-drafts";
import { registerTurnStartResolver } from "@/stores/server-turn-start";
import { handleAppEnvelope, notifyTransition } from "@/stores/session-status-handlers";
import { statusSyncPatch, type StatusSyncEntry } from "@/stores/session-status-patch";
import {
  installSessionStatusEffects,
  useSessionStatusStore,
  type SessionStatusEffects,
  type SessionStatusEntry,
} from "@/stores/session-status-store";
import { installSessionPresentationEffects, useWsSessionStore } from "@/stores/ws-session-store";
import { updateSession, type WsSessionStore } from "@/stores/ws-session-types";

const IDLE_ENTRY: StatusSyncEntry = { status: "idle", kind: null, turnStartedAtMs: null };

function syncConversations(
  previous: Record<number, SessionStatusEntry>,
  next: Record<number, SessionStatusEntry>,
  onlySessionId?: number,
): void {
  const store = useWsSessionStore.getState();
  let updated: WsSessionStore = store;
  const nowMs = Date.now();
  for (const [sessionId, session] of Object.entries(store.sessions)) {
    const dbId = session.sessionDbId;
    if (dbId == null || (onlySessionId != null && dbId !== onlySessionId)) continue;
    // Snapshots omit idle sessions. End only a turn the status book knew was busy.
    const wasBusy = (previous[dbId]?.status ?? "idle") !== "idle";
    const entry = next[dbId] ?? (wasBusy ? IDLE_ENTRY : null);
    const current = updated.sessions[sessionId];
    if (!entry || !current) continue;
    const patch = statusSyncPatch(current, entry, previous[dbId], {
      serverStartedAtLocalMs:
        entry.turnStartedAtMs == null ? null : serverToLocalMs(entry.turnStartedAtMs),
      nowMs,
    });
    if (patch) updated = { ...updated, ...updateSession(updated, sessionId, patch) };
  }
  if (updated !== store) useWsSessionStore.setState(updated);
}

const statusEffects: SessionStatusEffects = {
  handleEnvelope(domain, action, payload) {
    if (domain === "editor" && action === "file_tree.changed") {
      revealAgentDocument(payload, useSessionStatusStore.getState().bySession);
    }
    if (handleAppSocketError(domain, action, payload)) return;
    handleAppEnvelope(domain, action, payload);
  },
  snapshotApplied(previous, next, previousEpoch, epoch) {
    // A restarted server has a fresh book: restored gates need their notification again.
    const before =
      epoch != null && previousEpoch != null && epoch !== previousEpoch ? {} : previous;
    for (const [id, entry] of Object.entries(next)) {
      if (entry.status === "question" && before[Number(id)]?.status !== "question") {
        notifyTransition(entry.featureId, before[Number(id)]?.status, entry.status);
      }
    }
    reconcileQuestionDrafts(previous, next);
    syncConversations(previous, next);
  },
  updateApplied(previous, result) {
    if (result.next) reconcileQuestionDrafts(previous, result.next);
    if (
      result.entry &&
      result.sessionId != null &&
      (result.next || result.entry.status !== "idle")
    ) {
      syncConversations(previous, result.next ?? previous, result.sessionId);
    }
    if (result.featureId != null && result.nextStatus) {
      notifyTransition(result.featureId, result.prevStatus, result.nextStatus, result.failed);
    }
  },
};

/** Install before mounting any consumer or connecting either WebSocket. */
export function installSessionIntegration(): () => void {
  const removeStatusEffects = installSessionStatusEffects(statusEffects);
  let removePresentationEffects: () => void;
  try {
    removePresentationEffects = installSessionPresentationEffects({
      onUserPromptDispatched(featureId) {
        noteUserPrompt(featureId);
        acknowledgeForMe(featureId);
      },
    });
  } catch (error) {
    removeStatusEffects();
    throw error;
  }
  const removeResolver = registerTurnStartResolver((sessionDbId) => {
    const startedAt = useSessionStatusStore.getState().bySession[sessionDbId]?.turnStartedAtMs;
    return startedAt == null ? null : serverToLocalMs(startedAt);
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    useSessionStatusStore.getState().disconnect();
    const sessions = useWsSessionStore.getState();
    for (const sessionId of Object.keys(sessions.sessions)) sessions.release(sessionId);
    removeResolver();
    removePresentationEffects();
    removeStatusEffects();
  };
}

/** Own integration and React root together so HMR/unmount cannot leave stale callbacks. */
export function mountSessionApplication(mount: () => () => void): () => void {
  const disposeIntegration = installSessionIntegration();
  let unmount: () => void;
  try {
    unmount = mount();
  } catch (error) {
    disposeIntegration();
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      unmount();
    } finally {
      disposeIntegration();
    }
  };
}
