/** Backend status reducers: no store reads, notifications, or presentation effects. */
import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import type { SessionStatusEntry } from "./session-status-store";

const STATUS_VALUES: LiveAgentStatus[] = ["idle", "agent", "question"];
const PENDING_KIND_VALUES: PendingKind[] = ["permission", "question"];

function isStatus(val: unknown): val is LiveAgentStatus {
  return typeof val === "string" && (STATUS_VALUES as string[]).includes(val);
}

function isPendingKind(val: unknown): val is PendingKind {
  return typeof val === "string" && (PENDING_KIND_VALUES as string[]).includes(val);
}

/** Where a snapshot sits in the server's event stream. */
export function snapshotCursor(payload: Record<string, unknown>): {
  seq: number;
  epoch: number | null;
} {
  return {
    seq: typeof payload.seq === "number" ? payload.seq : 0,
    epoch: typeof payload.epoch === "number" ? payload.epoch : null,
  };
}

/**
 * Apply a `session_status.snapshot` envelope to the per-session map. Pure
 * over `current` — see store comments for the seq-merge invariants.
 */
export function applySnapshot(
  current: Record<number, SessionStatusEntry>,
  payload: Record<string, unknown>,
  previousEpoch: number | null = null,
): Record<number, SessionStatusEntry> {
  const rawStates = (payload.states ?? {}) as Record<string, unknown>;
  const { seq: snapshotSeq, epoch } = snapshotCursor(payload);
  // A restarted server's seqs start over: nothing from before compares.
  const prev = epoch != null && previousEpoch != null && epoch !== previousEpoch ? {} : current;
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
  snapshotSeq = 0,
): {
  next: Record<number, SessionStatusEntry> | null;
  sessionId: number | null;
  featureId: number | null;
  prevStatus: LiveAgentStatus | undefined;
  nextStatus: LiveAgentStatus | null;
  /** The update ended a failed turn (`outcome: "failed"`). */
  failed: boolean;
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
      failed: false,
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
      failed: false,
      entry: null,
    };
  }
  const kind = isPendingKind(payload.kind) ? payload.kind : null;
  const requestId = typeof payload.request_id === "string" ? payload.request_id : null;
  const failed = payload.status === "idle" && payload.outcome === "failed";

  const existing = prev[sessionId];
  if ((existing && seq <= existing.seq) || seq <= snapshotSeq) {
    // Out-of-order, or already folded into the last snapshot — drop.
    return {
      next: null,
      sessionId,
      featureId,
      prevStatus: existing?.status,
      nextStatus: null,
      failed: false,
      entry: null,
    };
  }

  const sameValue =
    existing?.status === payload.status &&
    (existing?.kind ?? null) === kind &&
    (existing?.requestId ?? null) === requestId &&
    (existing?.turnStartedAtMs ?? null) === turnStartedAtMs &&
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
      failed,
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
    failed,
    entry: { status: payload.status, kind, requestId, turnStartedAtMs },
  };
}
