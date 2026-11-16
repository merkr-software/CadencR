/**
 * Provider-neutral PR/MR status pushed by the forge poller.
 *
 * The backend is the only writer of forge state. HTTP hydration and WebSocket
 * updates both flow through `setStatus`, which rejects stale snapshots.
 */
import { create } from "zustand";
import type { BranchPr, CiRollup, ForgeUser, PrStatusSnapshot, PrSummary } from "@/api/generated";

interface PrStatusState {
  byFeature: Record<number, PrStatusSnapshot>;
  latestFetchedAtByFeature: Record<number, number>;
  setStatus: (snapshot: PrStatusSnapshot) => void;
  hydrate: (snapshots: PrStatusSnapshot[]) => void;
  clearStatus: (featureId: number) => void;
}

export const usePrStatusStore = create<PrStatusState>((set) => ({
  byFeature: {},
  latestFetchedAtByFeature: {},

  setStatus(snapshot) {
    set((state) => {
      const existing = state.byFeature[snapshot.feature_id];
      const latestFetchedAt =
        state.latestFetchedAtByFeature[snapshot.feature_id] ?? existing?.fetched_at;
      if (latestFetchedAt != null && latestFetchedAt > snapshot.fetched_at) return state;
      const latestFetchedAtByFeature =
        latestFetchedAt === snapshot.fetched_at
          ? state.latestFetchedAtByFeature
          : {
              ...state.latestFetchedAtByFeature,
              [snapshot.feature_id]: snapshot.fetched_at,
            };
      if (existing && prStatusSnapshotsEqual(existing, snapshot)) {
        return latestFetchedAtByFeature === state.latestFetchedAtByFeature
          ? state
          : { latestFetchedAtByFeature };
      }
      return {
        byFeature: {
          ...state.byFeature,
          [snapshot.feature_id]: snapshot,
        },
        latestFetchedAtByFeature,
      };
    });
  },

  hydrate(snapshots) {
    set((state) => {
      let byFeature: Record<number, PrStatusSnapshot> | undefined;
      let latestFetchedAtByFeature: Record<number, number> | undefined;
      for (const snapshot of snapshots) {
        const existing = (byFeature ?? state.byFeature)[snapshot.feature_id];
        const latestFetchedAt =
          (latestFetchedAtByFeature ?? state.latestFetchedAtByFeature)[snapshot.feature_id] ??
          existing?.fetched_at;
        if (latestFetchedAt != null && latestFetchedAt > snapshot.fetched_at) continue;
        if (latestFetchedAt !== snapshot.fetched_at) {
          latestFetchedAtByFeature ??= { ...state.latestFetchedAtByFeature };
          latestFetchedAtByFeature[snapshot.feature_id] = snapshot.fetched_at;
        }
        if (existing && prStatusSnapshotsEqual(existing, snapshot)) continue;
        byFeature ??= { ...state.byFeature };
        byFeature[snapshot.feature_id] = snapshot;
      }
      if (!byFeature && !latestFetchedAtByFeature) return state;
      return {
        ...(byFeature ? { byFeature } : {}),
        ...(latestFetchedAtByFeature ? { latestFetchedAtByFeature } : {}),
      };
    });
  },

  clearStatus(featureId) {
    set((state) => {
      if (!state.byFeature[featureId] && state.latestFetchedAtByFeature[featureId] == null) {
        return state;
      }
      const byFeature = { ...state.byFeature };
      const latestFetchedAtByFeature = { ...state.latestFetchedAtByFeature };
      delete byFeature[featureId];
      delete latestFetchedAtByFeature[featureId];
      return { byFeature, latestFetchedAtByFeature };
    });
  },
}));

export function selectPrStatus(
  featureId: number | null | undefined,
): (state: PrStatusState) => PrStatusSnapshot | undefined {
  return (state) => (featureId == null ? undefined : state.byFeature[featureId]);
}

/**
 * Whether an incoming snapshot is worth storing. Must stay in step with the
 * backend's `PrStatusSnapshot::semantic_eq`: anything the backend bothers to
 * broadcast but this call treats as equal is a push the UI silently drops.
 */
export function prStatusSnapshotsEqual(a: PrStatusSnapshot, b: PrStatusSnapshot): boolean {
  return (
    a.feature_id === b.feature_id &&
    a.setup_required === b.setup_required &&
    a.error === b.error &&
    a.unresolved_threads === b.unresolved_threads &&
    prSummariesEqual(a.pr, b.pr) &&
    ciRollupsEqual(a.ci, b.ci) &&
    branchPrsEqual(a.other_prs ?? [], b.other_prs ?? [])
  );
}

function branchPrsEqual(a: readonly BranchPr[], b: readonly BranchPr[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other != null &&
      entry.branch === other.branch &&
      entry.unresolved_threads === other.unresolved_threads &&
      prSummariesEqual(entry.pr, other.pr) &&
      ciRollupsEqual(entry.ci, other.ci)
    );
  });
}

function prSummariesEqual(
  a: PrSummary | null | undefined,
  b: PrSummary | null | undefined,
): boolean {
  if (a == null || b == null) return a === b;
  return (
    a.number === b.number &&
    a.title === b.title &&
    a.body_markdown === b.body_markdown &&
    a.state === b.state &&
    a.url === b.url &&
    a.source_branch === b.source_branch &&
    a.target_branch === b.target_branch &&
    a.head_sha === b.head_sha &&
    a.review_state === b.review_state &&
    forgeUsersEqual(a.author, b.author) &&
    a.updated_at === b.updated_at &&
    a.pr_label === b.pr_label
  );
}

function forgeUsersEqual(a: ForgeUser, b: ForgeUser): boolean {
  return (
    a.username === b.username && a.display_name === b.display_name && a.avatar_url === b.avatar_url
  );
}

function ciRollupsEqual(a: CiRollup | null | undefined, b: CiRollup | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  if (a.state !== b.state || a.checks.length !== b.checks.length) return false;
  return a.checks.every((check, index) => {
    const other = b.checks[index];
    return (
      other != null &&
      check.name === other.name &&
      check.state === other.state &&
      check.url === other.url
    );
  });
}
