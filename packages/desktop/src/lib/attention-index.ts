import type { SessionStatusEntry } from "@/stores/session-status-store";
import type { AttentionState } from "@/lib/sidebar-attention";

export type ActiveAttentionState = Exclude<AttentionState, "idle">;

export interface AttentionEntry {
  featureId: number;
  state: ActiveAttentionState;
}

/** Feature ids by live status, each list oldest first. */
export interface LiveAttentionIds {
  /** Waiting on the user, by when the request arrived (`seq`). */
  waiting: number[];
  working: number[];
}

/** Feature ids by unseen outcome, each list oldest first. */
export interface MarkedAttentionIds {
  failed: number[];
  unread: number[];
}

/**
 * One pass over the sessions: every feature waiting on the user, oldest request
 * first (a feature with several waiting sessions counts its oldest), then every
 * feature at work that is not also waiting.
 */
export function liveAttentionIds(bySession: Record<number, SessionStatusEntry>): LiveAttentionIds {
  const waitingSince = new Map<number, number>();
  const working = new Set<number>();
  for (const entry of Object.values(bySession)) {
    if (entry.status === "question") {
      const since = waitingSince.get(entry.featureId);
      if (since == null || entry.seq < since) waitingSince.set(entry.featureId, entry.seq);
    } else if (entry.status === "agent") {
      working.add(entry.featureId);
    }
  }
  const waiting = [...waitingSince.entries()]
    .sort(([idA, seqA], [idB, seqB]) => seqA - seqB || idA - idB)
    .map(([id]) => id);
  return {
    waiting,
    working: [...working].filter((id) => !waitingSince.has(id)).sort((a, b) => a - b),
  };
}

/** Failed and unread features in the order they were first marked. */
export function markedAttentionIds(
  failedByFeature: Record<number, true>,
  byFeature: Record<number, true>,
  markedOrder: Record<number, number>,
): MarkedAttentionIds {
  const byOrder = (a: number, b: number) => (markedOrder[a] ?? 0) - (markedOrder[b] ?? 0) || a - b;
  const failed = Object.keys(failedByFeature).map(Number).sort(byOrder);
  const failedSet = new Set(failed);
  const unread = Object.keys(byFeature)
    .map(Number)
    .filter((id) => !failedSet.has(id))
    .sort(byOrder);
  return { failed, unread };
}

/**
 * Every feature that needs or deserves a look, most urgent state first and,
 * within a state, oldest first: the "For me" queue (E10). A feature appears
 * once, under its most urgent state (`deriveAttention`'s ladder).
 */
export function buildAttentionIndex(
  live: LiveAttentionIds,
  marked: MarkedAttentionIds,
): AttentionEntry[] {
  const seen = new Set<number>();
  const entries: AttentionEntry[] = [];
  const add = (ids: readonly number[], state: ActiveAttentionState) => {
    for (const featureId of ids) {
      if (seen.has(featureId)) continue;
      seen.add(featureId);
      entries.push({ featureId, state });
    }
  };
  add(live.waiting, "waiting");
  add(marked.failed, "failed");
  add(live.working, "working");
  add(marked.unread, "unread");
  return entries;
}
