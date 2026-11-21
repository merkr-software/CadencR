// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGetFeatureAgentStateQueryKey,
  getGetFeatureSettingsQueryKey,
  getListLayoutsQueryKey,
  type FeatureAgentStateResponse,
} from "@/api/generated";
import { queryClient } from "@/lib/queryClient";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { flatLayoutState } from "@/stores/feature-layout-schema";
import {
  CONVERSATION_SNAPSHOT_PARAMS,
  SNAPSHOT_MAX_AGE_MS,
  hydrateBeforeNavigation,
  hydratePreloadedConversation,
  preloadConversation,
  takeSnapshotHydration,
} from "./conversation-preload";

const mocks = vi.hoisted(() => ({ release: vi.fn(), retain: vi.fn() }));

vi.mock("@/hooks/ws-session-retention", () => ({
  retainWsSession: (sessionId: string) => {
    mocks.retain(sessionId);
    return mocks.release;
  },
}));

// The mapping from the wire shape has its own tests: a marker is enough here.
vi.mock("@/lib/conversation-snapshot", () => ({
  conversationSnapshot: (response: FeatureAgentStateResponse, featureId: number) =>
    response.sessions.length === 0
      ? null
      : {
          blocks: [{ id: "persisted-1", type: "text", content: "hello" }],
          lifecycle: { phase: "idle" },
          featureId,
          sessionDbId: 42,
          maxMessageId: 9,
        },
}));

const FEATURE_ID = 7;
const SESSION_ID = "ws-feature-7";
const snapshotKey = getGetFeatureAgentStateQueryKey(FEATURE_ID, CONVERSATION_SNAPSHOT_PARAMS);
const withSession = { sessions: [{}] } as unknown as FeatureAgentStateResponse;
const withoutSession: FeatureAgentStateResponse = { sessions: [] };

describe("conversation preload", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-21T10:00:00Z") });
    queryClient.clear();
    useWsSessionStore.setState({ sessions: {} });
    useFeatureLayoutStore.setState({ features: {} });
    mocks.retain.mockClear();
    mocks.release.mockClear();
    takeSnapshotHydration(SESSION_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("hydrates the session store from a preloaded snapshot", () => {
    queryClient.setQueryData(snapshotKey, withSession);

    expect(hydratePreloadedConversation(FEATURE_ID)).toBe(true);

    const session = useWsSessionStore.getState().sessions[SESSION_ID];
    expect(session?.persistedLoaded).toBe(true);
    expect(session?.blocks.map((block) => block.id)).toEqual(["persisted-1"]);
    expect(session?.sessionDbId).toBe(42);
  });

  it("drops the cached copy and lets the entry expire if no workspace takes it", () => {
    queryClient.setQueryData(snapshotKey, withSession);

    hydratePreloadedConversation(FEATURE_ID);

    expect(queryClient.getQueryData(snapshotKey)).toBeUndefined();
    expect(mocks.retain).toHaveBeenCalledWith(SESSION_ID);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("owes one catch-up to a session hydrated from a snapshot", () => {
    queryClient.setQueryData(snapshotKey, withSession);
    hydratePreloadedConversation(FEATURE_ID);

    expect(takeSnapshotHydration(SESSION_ID)).toBe(true);
    expect(takeSnapshotHydration(SESSION_ID)).toBe(false);
  });

  it("settles the history gate of a conversation that has no session yet", () => {
    queryClient.setQueryData(snapshotKey, withoutSession);

    expect(hydratePreloadedConversation(FEATURE_ID)).toBe(true);

    const session = useWsSessionStore.getState().sessions[SESSION_ID];
    expect(session?.persistedLoaded).toBe(true);
    expect(session?.blocks).toEqual([]);
  });

  it("leaves a conversation without a snapshot to its workspace's loader", () => {
    expect(hydratePreloadedConversation(FEATURE_ID)).toBe(false);
    expect(useWsSessionStore.getState().sessions[SESSION_ID]).toBeUndefined();
    expect(takeSnapshotHydration(SESSION_ID)).toBe(false);
  });

  it("refuses a snapshot that is too old", () => {
    queryClient.setQueryData(snapshotKey, withSession);
    vi.advanceTimersByTime(SNAPSHOT_MAX_AGE_MS + 1);

    expect(hydratePreloadedConversation(FEATURE_ID)).toBe(false);
    expect(useWsSessionStore.getState().sessions[SESSION_ID]).toBeUndefined();
  });

  it("never overwrites a session that is already loaded", () => {
    useWsSessionStore.getState().hydratePersistedState(SESSION_ID, null);
    const live = useWsSessionStore.getState().sessions[SESSION_ID];
    queryClient.setQueryData(snapshotKey, withSession);

    expect(hydratePreloadedConversation(FEATURE_ID)).toBe(false);

    expect(useWsSessionStore.getState().sessions[SESSION_ID]).toBe(live);
    expect(takeSnapshotHydration(SESSION_ID)).toBe(false);
  });

  it("hydrates the layout from cached settings, keeping a layout already in the store", () => {
    queryClient.setQueryData(getGetFeatureSettingsQueryKey(FEATURE_ID), []);
    queryClient.setQueryData(getListLayoutsQueryKey(), []);

    hydratePreloadedConversation(FEATURE_ID);

    const hydrated = useFeatureLayoutStore.getState().features[FEATURE_ID];
    expect(hydrated).toEqual(flatLayoutState());

    hydratePreloadedConversation(FEATURE_ID);
    expect(useFeatureLayoutStore.getState().features[FEATURE_ID]).toBe(hydrated);
  });

  it("fetches the snapshot the workspace loader would ask for", () => {
    const prefetch = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue();

    preloadConversation(FEATURE_ID, 1_000);

    const keys = prefetch.mock.calls.map(([options]) => options.queryKey);
    expect(keys).toContainEqual(snapshotKey);
    expect(prefetch).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: snapshotKey, staleTime: 1_000, retry: false }),
    );
  });

  it("does not refetch a conversation whose session is live in the store", () => {
    useWsSessionStore.getState().hydratePersistedState(SESSION_ID, null);
    const live = useWsSessionStore.getState().sessions[SESSION_ID];
    const prefetch = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue();

    preloadConversation(FEATURE_ID);

    const keys = prefetch.mock.calls.map(([options]) => options.queryKey);
    expect(keys).not.toContainEqual(snapshotKey);
    // The live entry is what opening it shows: nothing to hydrate over it.
    expect(hydratePreloadedConversation(FEATURE_ID)).toBe(false);
    expect(useWsSessionStore.getState().sessions[SESSION_ID]).toBe(live);
  });

  it("refetches on a hover only a snapshot older than thirty seconds", () => {
    const prefetch = vi.spyOn(queryClient, "prefetchQuery").mockResolvedValue();

    preloadConversation(FEATURE_ID);

    expect(prefetch).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: snapshotKey, staleTime: 30_000 }),
    );
  });
});

describe("hydration before a navigation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-21T10:00:00Z") });
    queryClient.clear();
    useWsSessionStore.setState({ sessions: {} });
    takeSnapshotHydration(SESSION_ID);
  });

  afterEach(() => vi.useRealTimers());

  it("puts the preloaded conversation being opened into the store", () => {
    queryClient.setQueryData(snapshotKey, withSession);

    hydrateBeforeNavigation({
      pathname: `/ws-session/${SESSION_ID}`,
      search: { cwd: "/repo", featureId: FEATURE_ID, projectId: 1 },
    });

    expect(useWsSessionStore.getState().sessions[SESSION_ID]?.persistedLoaded).toBe(true);
    expect(takeSnapshotHydration(SESSION_ID)).toBe(true);
  });

  it("leaves the stores alone for any other destination", () => {
    queryClient.setQueryData(snapshotKey, withSession);

    hydrateBeforeNavigation({ pathname: "/settings", search: { featureId: FEATURE_ID } });
    hydrateBeforeNavigation({ pathname: `/ws-session/${SESSION_ID}`, search: {} });
    hydrateBeforeNavigation({ pathname: `/ws-session/${SESSION_ID}`, search: { featureId: "x" } });

    expect(useWsSessionStore.getState().sessions[SESSION_ID]).toBeUndefined();
    expect(queryClient.getQueryData(snapshotKey)).toBe(withSession);
  });
});
