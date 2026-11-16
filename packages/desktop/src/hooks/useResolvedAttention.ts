import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { toast } from "sonner";
import { FeatureStatus, getGetFeatureQueryOptions, type Feature } from "@/api/generated";
import { useAttentionIndex } from "@/hooks/useAttentionIndex";
import { apiErrorMessage } from "@/lib/api-errors";
import type { ActiveAttentionState, AttentionEntry } from "@/lib/attention-index";
import {
  deriveNextActions,
  type NextActionEntry,
  type ResolvedNextAction,
} from "@/lib/next-actions";
import { needsUser } from "@/lib/sidebar-attention";
import { lookupFeature, lookupListedFeature } from "@/stores/session-status-handlers";
import { useUnreadStore } from "@/stores/unread-store";
import { usePrStatusStore } from "@/stores/usePrStatusStore";

export interface ResolvedAttention {
  feature: Feature;
  state: ActiveAttentionState;
}

export interface ProjectAttentionCounts {
  waiting: number;
  failed: number;
  working: number;
  unread: number;
}

export interface ResolvedAttentionResult {
  /** The attention index itself, straight from the stores (no request). */
  entries: readonly AttentionEntry[];
  /** Every conversation needing a look, in the attention index's order. */
  items: readonly ResolvedAttention[];
  /** The items asking something of the user: agents at work left out. */
  queue: readonly ResolvedAttention[];
  byProject: ReadonlyMap<number, ProjectAttentionCounts>;
  /**
   * The states with a conversation still being looked up, each once in index
   * order: a surface waits only on the states it shows.
   */
  loadingStates: readonly ActiveAttentionState[];
  /**
   * The "For me" action list, most urgent first: the attention index plus what
   * each conversation's pull request asks for, one action per conversation.
   */
  actions: readonly ResolvedNextAction[];
  /** Whether a conversation in the action list is still being looked up. */
  actionsLoading: boolean;
}

interface FeatureResult {
  data?: Feature;
  error: unknown;
  isPending: boolean;
}

const FEATURE_STALE_MS = 60_000;
const ERROR_TOAST_ID = "sidebar-attention-load-error";

/**
 * The attention index with each conversation's record, so surfaces can show its
 * title and group it by project even when that project is collapsed and its
 * list was never fetched. A conversation already in a loaded project list
 * starts from that record; the others cost one small request each, cached and
 * shared by every surface. Archived and deleted conversations drop out.
 *
 * The same lookups resolve the "For me" action list, whose pull request
 * actions can name a conversation the attention index doesn't hold; those
 * actions stay out of `items`, so badges and the rail only count attention.
 */
export function useResolvedAttention(): ResolvedAttentionResult {
  const entries = useAttentionIndex();
  // The store keeps `byFeature` while pushes change nothing, so this re-derives
  // only on a real pull request change.
  const prByFeature = usePrStatusStore((state) => state.byFeature);
  const prAcks = useUnreadStore((state) => state.prAcks);
  const actionEntries = useMemo(
    () => deriveNextActions(entries, prByFeature, prAcks),
    [entries, prByFeature, prAcks],
  );
  // Conversations with only a dismissed pull request action are looked up
  // too, so their dismissal goes with them once they are archived.
  const ackedIds = useMemo(() => Object.keys(prAcks).map(Number), [prAcks]);
  const ids = useMemo(
    () => lookupIds(entries, actionEntries, ackedIds),
    [entries, actionEntries, ackedIds],
  );
  const combine = useCallback(
    (results: FeatureResult[]) => resolveAll(entries, actionEntries, ackedIds, ids, results),
    [entries, actionEntries, ackedIds, ids],
  );
  const resolved = useQueries({
    queries: ids.map((featureId) =>
      getGetFeatureQueryOptions(featureId, {
        query: {
          staleTime: FEATURE_STALE_MS,
          retry: false,
          initialData: () => lookupFeature(featureId),
          // A list fetched before the latest prompt can name an older provider
          // or model: the seed is only as fresh as its list.
          initialDataUpdatedAt: () => lookupListedFeature(featureId)?.updatedAt,
        },
      }),
    ),
    combine,
  });
  useEffect(() => {
    if (resolved.error) {
      toast.error(apiErrorMessage(resolved.error, "Could not load conversations needing you"), {
        id: ERROR_TOAST_ID,
      });
    }
  }, [resolved.error]);
  useClearGoneMarks(resolved.goneMarks);
  const byProject = useStableProjectCounts(resolved.items);
  const queue = useMemo(
    () => resolved.items.filter((item) => needsUser(item.state)),
    [resolved.items],
  );
  return useMemo(
    () => ({
      entries,
      items: resolved.items,
      queue,
      byProject,
      loadingStates: resolved.loadingStates,
      actions: resolved.actions,
      actionsLoading: resolved.actionsLoading,
    }),
    [
      entries,
      resolved.items,
      queue,
      byProject,
      resolved.loadingStates,
      resolved.actions,
      resolved.actionsLoading,
    ],
  );
}

/**
 * A persisted unread or failure mark can outlive its conversation: once the
 * lookup finds it archived or deleted, the mark goes (with any pull request
 * action marked done), so it never resurfaces.
 */
function useClearGoneMarks(featureIds: readonly number[]): void {
  useEffect(() => {
    const { forget } = useUnreadStore.getState();
    for (const featureId of featureIds) forget(featureId);
  }, [featureIds]);
}

/** Every conversation to look up, once: the attention index, then PR-only actions. */
function lookupIds(
  entries: readonly AttentionEntry[],
  actions: readonly NextActionEntry[],
  ackedIds: readonly number[],
): number[] {
  const ids = entries.map((entry) => entry.featureId);
  const seen = new Set(ids);
  for (const featureId of [...actions.map((action) => action.featureId), ...ackedIds]) {
    if (!seen.has(featureId)) {
      seen.add(featureId);
      ids.push(featureId);
    }
  }
  return ids;
}

function resolveAll(
  entries: readonly AttentionEntry[],
  actionEntries: readonly NextActionEntry[],
  ackedIds: readonly number[],
  ids: readonly number[],
  results: FeatureResult[],
) {
  const byId = new Map<number, FeatureResult>();
  results.forEach((result, index) => {
    const featureId = ids[index];
    if (featureId != null) byId.set(featureId, result);
  });
  const resolvedEntries = resolveEntries(entries, byId);
  const goneMarks = [...resolvedEntries.goneMarks];
  for (const featureId of ackedIds) {
    const result = byId.get(featureId);
    if (result && isGone(result) && !goneMarks.includes(featureId)) goneMarks.push(featureId);
  }
  return {
    ...resolvedEntries,
    goneMarks,
    ...resolveActions(actionEntries, byId),
    error: firstError(results),
  };
}

function resolveEntries(entries: readonly AttentionEntry[], byId: Map<number, FeatureResult>) {
  const items: ResolvedAttention[] = [];
  // Arrays, not Sets: `combine`'s structural sharing keeps them stable while equal.
  const loadingStates: ActiveAttentionState[] = [];
  const goneMarks: number[] = [];
  for (const entry of entries) {
    const result = byId.get(entry.featureId);
    if (!result) continue;
    if (result.isPending && !loadingStates.includes(entry.state)) loadingStates.push(entry.state);
    const feature = activeFeature(result);
    if (feature) items.push({ feature, state: entry.state });
    else if (isGone(result) && (entry.state === "failed" || entry.state === "unread")) {
      goneMarks.push(entry.featureId);
    }
  }
  return { items, loadingStates, goneMarks };
}

function resolveActions(
  actionEntries: readonly NextActionEntry[],
  byId: Map<number, FeatureResult>,
) {
  const actions: ResolvedNextAction[] = [];
  let actionsLoading = false;
  for (const { featureId, kind } of actionEntries) {
    const result = byId.get(featureId);
    if (!result) continue;
    if (result.isPending) actionsLoading = true;
    const feature = activeFeature(result);
    if (feature) actions.push({ feature, kind });
  }
  return { actions, actionsLoading };
}

/** The conversation's record, unless it was archived or deleted since. */
function activeFeature(result: FeatureResult): Feature | undefined {
  return isGone(result) ? undefined : result.data;
}

/** Archived, or deleted (404): the conversation has left for good. */
function isGone(result: FeatureResult): boolean {
  return result.data?.status === FeatureStatus.archived || isNotFound(result.error);
}

function firstError(results: readonly FeatureResult[]): unknown {
  return results.find((result) => result.error && !isNotFound(result.error))?.error ?? null;
}

/** A deleted conversation can keep a status or unread mark: it simply leaves. */
function isNotFound(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 404;
}

export function countByProject(
  items: readonly ResolvedAttention[],
): Map<number, ProjectAttentionCounts> {
  const counts = new Map<number, ProjectAttentionCounts>();
  for (const { feature, state } of items) {
    const current = counts.get(feature.project_id) ?? {
      waiting: 0,
      failed: 0,
      working: 0,
      unread: 0,
    };
    current[state] += 1;
    counts.set(feature.project_id, current);
  }
  return counts;
}

function sameCounts(a: ProjectAttentionCounts, b: ProjectAttentionCounts): boolean {
  return (
    a.waiting === b.waiting &&
    a.failed === b.failed &&
    a.working === b.working &&
    a.unread === b.unread
  );
}

/**
 * Per-project counts that keep their identity while unchanged, so a memoized
 * project badge re-renders only when its own project's counts move.
 */
function useStableProjectCounts(
  items: readonly ResolvedAttention[],
): ReadonlyMap<number, ProjectAttentionCounts> {
  const previous = useRef<ReadonlyMap<number, ProjectAttentionCounts>>(new Map());
  return useMemo(() => {
    const next = countByProject(items);
    const prior = previous.current;
    for (const [projectId, counts] of next) {
      const old = prior.get(projectId);
      if (old && sameCounts(old, counts)) next.set(projectId, old);
    }
    previous.current = next;
    return next;
  }, [items]);
}
