/**
 * Getting a conversation's data into memory before it is opened.
 *
 * Opening a conversation used to start its history request from the mounted
 * workspace: a round trip to the service (tens to hundreds of milliseconds,
 * depending on the conversation) between the click and the first message on
 * screen. Here the same snapshot is fetched as soon as the user shows intent
 * (hovering or pressing a sidebar row, moving keyboard focus onto it) and for
 * the rows in view while the app is idle. When the navigation starts, the
 * snapshot goes into the session store and the layout store, so the workspace
 * renders the transcript in its first commit.
 *
 * A snapshot is taken before the session's socket is bound, so it can miss
 * what the agent wrote in between. `takeSnapshotHydration` lets the workspace
 * run one incremental catch-up once the session is live.
 */
import {
  getGetFeatureAgentStateQueryKey,
  getGetFeatureAgentStateQueryOptions,
  getGetFeatureSettingsQueryKey,
  getGetFeatureSettingsQueryOptions,
  getListLayoutsQueryKey,
  getListLayoutsQueryOptions,
  type FeatureAgentStateResponse,
  type FeatureLayout,
  type FeatureSetting,
} from "@/api/generated";
import { retainWsSession } from "@/hooks/ws-session-retention";
import { AGENT_STATE_INITIAL_MESSAGE_LIMIT } from "@/lib/agent-state-limits";
import { conversationSnapshot } from "@/lib/conversation-snapshot";
import { hydrateFeatureLayout } from "@/lib/feature-layout-hydration";
import { queryClient } from "@/lib/queryClient";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { useWsSessionStore } from "@/stores/ws-session-store";

/** The first page every conversation opens on; one shared key for loader and preload. */
export const CONVERSATION_SNAPSHOT_PARAMS = { limit: AGENT_STATE_INITIAL_MESSAGE_LIMIT } as const;

/**
 * How old a snapshot may be and still open a conversation. Older than this,
 * the workspace loads its history itself (and shows that it is loading).
 */
export const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

/**
 * A hover or keyboard focus refetches a snapshot older than this. Freshness
 * right before opening is the press's job (`useConversationPreloadIntent`)
 * and the catch-up's (`takeSnapshotHydration`).
 */
const SNAPSHOT_REFRESH_AFTER_MS = 30_000;

/** Sessions hydrated from a snapshot that still owe their catch-up. */
const awaitingCatchUp = new Set<string>();

function isLoadedInStore(featureId: number): boolean {
  const session = useWsSessionStore.getState().sessions[wsSessionIdFromFeature(featureId)];
  return session?.persistedLoaded === true;
}

/**
 * Fetch what opening `featureId` needs, unless it is already in memory.
 * `refreshAfterMs` is how old an existing snapshot may be before it is fetched
 * again.
 *
 * A failed prefetch is not reported: nothing was asked for yet, and opening the
 * conversation runs the regular loader, which surfaces the failure with a retry.
 */
export function preloadConversation(
  featureId: number,
  refreshAfterMs: number = SNAPSHOT_REFRESH_AFTER_MS,
): void {
  void queryClient.prefetchQuery({
    ...getGetFeatureSettingsQueryOptions(featureId),
    staleTime: SNAPSHOT_MAX_AGE_MS,
  });
  void queryClient.prefetchQuery({
    ...getListLayoutsQueryOptions(),
    staleTime: SNAPSHOT_MAX_AGE_MS,
  });
  // A session already in the store is live: its socket keeps it current.
  if (isLoadedInStore(featureId)) return;
  void queryClient.prefetchQuery({
    ...getGetFeatureAgentStateQueryOptions(featureId, CONVERSATION_SNAPSHOT_PARAMS),
    staleTime: refreshAfterMs,
    gcTime: SNAPSHOT_MAX_AGE_MS,
    retry: false,
  });
}

function hydrateLayoutFromCache(featureId: number): void {
  const settings = queryClient.getQueryData<FeatureSetting[]>(
    getGetFeatureSettingsQueryKey(featureId),
  );
  const layouts = queryClient.getQueryData<FeatureLayout[]>(getListLayoutsQueryKey());
  if (settings === undefined || layouts === undefined) return;
  hydrateFeatureLayout(featureId, settings, layouts);
}

/**
 * Move a preloaded conversation into the stores, right before its workspace
 * mounts. Returns whether the transcript was hydrated from a snapshot.
 */
export function hydratePreloadedConversation(featureId: number): boolean {
  hydrateLayoutFromCache(featureId);
  if (isLoadedInStore(featureId)) return false;
  const queryKey = getGetFeatureAgentStateQueryKey(featureId, CONVERSATION_SNAPSHOT_PARAMS);
  const state = queryClient.getQueryState<FeatureAgentStateResponse>(queryKey);
  if (
    state?.status !== "success" ||
    state.data === undefined ||
    Date.now() - state.dataUpdatedAt > SNAPSHOT_MAX_AGE_MS
  ) {
    return false;
  }
  const sessionId = wsSessionIdFromFeature(featureId);
  useWsSessionStore
    .getState()
    .hydratePersistedState(sessionId, conversationSnapshot(state.data, featureId));
  awaitingCatchUp.add(sessionId);
  // The store owns the conversation from here; a second copy would only go stale.
  queryClient.removeQueries({ queryKey, exact: true });
  // If the navigation never mounts a workspace, the entry still expires.
  retainWsSession(sessionId)();
  return true;
}

/**
 * Called before React renders a navigation's destination (`router.ts`): a
 * conversation being opened goes into the stores with what was preloaded for
 * it, so its workspace mounts with content.
 */
export function hydrateBeforeNavigation(location: { pathname: string; search: unknown }): void {
  if (!location.pathname.startsWith("/ws-session/")) return;
  const { search } = location;
  const raw = typeof search === "object" && search !== null && "featureId" in search;
  const featureId = raw ? Number(search.featureId) : Number.NaN;
  if (Number.isInteger(featureId) && featureId > 0) hydratePreloadedConversation(featureId);
}

/**
 * Whether `sessionId` was hydrated from a snapshot and has not caught up yet.
 * Consumed by the call: the catch-up runs once.
 */
export function takeSnapshotHydration(sessionId: string): boolean {
  return awaitingCatchUp.delete(sessionId);
}
