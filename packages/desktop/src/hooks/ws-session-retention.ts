import { useSessionStatusStore } from "@/stores/session-status-store";
import { useWsSessionStore } from "@/stores/ws-session-store";

export const WS_SESSION_EVICTION_MS = 5 * 60_000;

interface RetentionEntry {
  references: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, RetentionEntry>();

function canEvictSession(sessionId: string): boolean {
  const session = useWsSessionStore.getState().sessions[sessionId];
  if (!session) return true;
  if (session.sessionDbId == null) {
    // An uninitialized, empty session is safe to release. Once the backend has
    // assigned a runtime id, wait for canonical status before tearing it down.
    return session.serverSessionId === "";
  }
  return useSessionStatusStore.getState().bySession[session.sessionDbId]?.status === "idle";
}

function scheduleEviction(sessionId: string, entry: RetentionEntry): void {
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.references > 0) return;
    if (!canEvictSession(sessionId)) {
      scheduleEviction(sessionId, entry);
      return;
    }
    useWsSessionStore.getState().disconnect(sessionId);
    entries.delete(sessionId);
  }, WS_SESSION_EVICTION_MS);
}

export function retainWsSession(sessionId: string): () => void {
  const entry = entries.get(sessionId) ?? { references: 0, timer: null };
  entries.set(sessionId, entry);
  entry.references += 1;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.references = Math.max(0, entry.references - 1);
    if (entry.references === 0 && !entry.timer) scheduleEviction(sessionId, entry);
  };
}

export function clearWsSessionRetentionForTests(): void {
  for (const entry of entries.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  entries.clear();
}
