import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, AxiosHeaders } from "axios";
import { act, createTestQueryClient, renderHook, waitFor } from "@/test-utils";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useGitStatusStore } from "@/stores/useGitStatusStore";
import { getGetGitStatusQueryKey, type GitStatusSnapshot } from "@/api/generated";
import { createSessionEntry, type SessionEntry } from "@/stores/ws-session-types";
import {
  claudeProfileForPrompt,
  useSessionFeatureData,
  useWsSessionEffects,
} from "./WebSocketSessionFeatureBlockHooks";

vi.mock("@/hooks/useAgentLetterFocus", () => ({ useAgentLetterFocus: vi.fn() }));
const getGitStatus = vi.hoisted(() => vi.fn<() => Promise<GitStatusSnapshot>>());
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  getGitStatus,
  useGetBranch: () => ({}),
  useGetFeatureSettings: () => ({}),
  useListFeatureWorktrees: () => ({}),
  useListProjects: () => ({}),
}));

const checkoutSnapshot: GitStatusSnapshot = {
  feature_id: 7,
  computed_at: 1,
  current_branch: "topic",
  target_branch: "main",
  target_resolved: true,
  uncommitted_count: 1,
  staged_count: 0,
  unstaged_count: 0,
  untracked_count: 1,
  ahead_of_remote: 0,
  behind_remote: 0,
  ahead_of_target: 0,
  has_remote: false,
};

function mountGitStatus(
  client = createTestQueryClient(),
  activity = createWorkspaceActivity(true),
) {
  return renderHook(() => useSessionFeatureData("ws-feature-7", "/repo", 7, 1), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>
      </QueryClientProvider>
    ),
  });
}

describe("useSessionFeatureData Git hydration", () => {
  afterEach(() => {
    getGitStatus.mockReset();
    useGitStatusStore.setState(useGitStatusStore.getInitialState());
  });

  it("surfaces the initial HTTP failure on the right feature", async () => {
    getGitStatus.mockRejectedValue(new Error("Cannot read Git status"));
    mountGitStatus();
    await waitFor(() => {
      const { healthByFeature } = useGitStatusStore.getState();
      expect(healthByFeature[7]).toMatchObject({ statusError: "Cannot read Git status" });
      expect(healthByFeature[1]).toBeUndefined();
    });
  });

  it("does not hydrate cached project status when a feature is reopened during an outage", async () => {
    const client = createTestQueryClient();
    const queryKey = getGetGitStatusQueryKey({ feature_id: 7 });
    client.setQueryData(queryKey, { ...checkoutSnapshot, current_branch: "main" });
    getGitStatus.mockRejectedValueOnce(
      new AxiosError("Conflict", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 409,
        statusText: "Conflict",
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: {
          code: "WORKTREE_UNAVAILABLE",
          error: "The feature's worktree is no longer available",
        },
      }),
    );
    mountGitStatus(client);
    expect(useGitStatusStore.getState().byFeature[7]).toBeUndefined();
    await waitFor(() =>
      expect(useGitStatusStore.getState().healthByFeature[7]?.statusErrorCode).toBe(
        "WORKTREE_UNAVAILABLE",
      ),
    );

    getGitStatus.mockResolvedValueOnce(checkoutSnapshot);
    await act(async () => {
      await client.refetchQueries({ queryKey });
    });
    expect(useGitStatusStore.getState().byFeature[7]?.current_branch).toBe("topic");
    expect(useGitStatusStore.getState().healthByFeature[7]).toBeUndefined();
  });

  it("discards an in-flight HTTP success overtaken by a worktree outage", async () => {
    let resolveStatus!: (status: GitStatusSnapshot) => void;
    getGitStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const client = createTestQueryClient();
    const queryKey = getGetGitStatusQueryKey({ feature_id: 7 });
    mountGitStatus(client);
    await waitFor(() => expect(getGitStatus).toHaveBeenCalledTimes(1));
    act(() =>
      useGitStatusStore.getState().setStatusError({
        feature_id: 7,
        code: "WORKTREE_UNAVAILABLE",
        error: "The feature's worktree is no longer available",
      }),
    );
    await act(async () => resolveStatus(checkoutSnapshot));
    await waitFor(() => expect(client.getQueryData(queryKey)).toEqual(checkoutSnapshot));
    expect(useGitStatusStore.getState().byFeature[7]).toBeUndefined();
    expect(useGitStatusStore.getState().healthByFeature[7]?.statusErrorCode).toBe(
      "WORKTREE_UNAVAILABLE",
    );
  });

  it("lets HTTP settle the status when the WebSocket drops before its first answer", async () => {
    let resolveStatus!: (status: GitStatusSnapshot) => void;
    getGitStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    mountGitStatus();
    await waitFor(() => expect(getGitStatus).toHaveBeenCalledTimes(1));
    const git = useGitStatusStore.getState();
    act(() => {
      git.setSubscription(7, "pending");
      git.setSubscription(7);
    });
    await act(async () => resolveStatus(checkoutSnapshot));
    await waitFor(() =>
      expect(useGitStatusStore.getState().byFeature[7]).toEqual(checkoutSnapshot),
    );
  });

  it("starts a fresh probe after reopening during a previous HTTP request", async () => {
    let oldResolve!: (status: GitStatusSnapshot) => void;
    getGitStatus
      .mockReturnValueOnce(
        new Promise((resolve) => {
          oldResolve = resolve;
        }),
      )
      .mockResolvedValueOnce(checkoutSnapshot);
    const activity = createWorkspaceActivity(true);
    mountGitStatus(createTestQueryClient(), activity);
    await waitFor(() => expect(getGitStatus).toHaveBeenCalledTimes(1));
    act(() => {
      activity.set(false);
      activity.set(true);
    });
    await waitFor(() =>
      expect(useGitStatusStore.getState().byFeature[7]).toEqual(checkoutSnapshot),
    );
    await act(async () => oldResolve({ ...checkoutSnapshot, current_branch: "main" }));
    expect(useGitStatusStore.getState().byFeature[7]?.current_branch).toBe("topic");
  });
});

type EffectsArgs = Parameters<typeof useWsSessionEffects>[0];

function render(session: SessionEntry, autoInitSession: boolean) {
  const initSession = vi.fn();
  const args = {
    sessionId: "ws-feature-7",
    cwd: "/repo",
    featureId: 7,
    data: { session, effectiveCwd: "/repo", requestSlashCommands: vi.fn() },
    controls: {
      ws: { initSession, isConnected: true, permissionMode: "default" },
      initializedRef: { current: null },
      claudeProfile: {},
    },
    refs: { agent: { current: null } },
    focusedTabId: "agent",
    hotkeysEnabled: false,
    autoFocusPrompt: false,
    autoInitSession,
  } as unknown as EffectsArgs;
  const hook = renderHook((props: EffectsArgs) => useWsSessionEffects(props), {
    initialProps: args,
  });
  return { initSession, args, hook };
}

function loadedSession(patch: Partial<SessionEntry> = {}): SessionEntry {
  return { ...createSessionEntry(), persistedLoaded: true, ...patch };
}

describe("useWsSessionEffects session initialization", () => {
  afterEach(() => useWsSessionStore.setState({ sessions: {} }));

  it("does not initialize an embedded session on mount", () => {
    const { initSession } = render(loadedSession(), false);
    expect(initSession).not.toHaveBeenCalled();
  });

  it("initializes an embedded session once a prompt is queued (issue #251)", () => {
    const { initSession, args, hook } = render(loadedSession(), false);
    const queued = loadedSession({ queuedPrompts: [{ text: "hello", messageUuid: "m-1" }] });
    hook.rerender({ ...args, data: { ...args.data, session: queued } });
    expect(initSession).toHaveBeenCalledTimes(1);
    expect(initSession).toHaveBeenCalledWith({
      cwd: "/repo",
      featureId: 7,
    });
  });

  it("lets the backend pick the initial mode unless the user made a pre-init choice", () => {
    const { initSession } = render(loadedSession({ permissionMode: "auto" }), true);
    expect(initSession).toHaveBeenCalledWith({ cwd: "/repo", featureId: 7 });
    const explicit = render(loadedSession({ pendingInitPermissionMode: "auto" }), true);
    expect(explicit.initSession).toHaveBeenCalledWith({
      cwd: "/repo",
      featureId: 7,
      permissionMode: "auto",
    });
  });

  it("does not re-initialize an already initialized session", () => {
    const session = loadedSession({
      serverSessionId: "server-1",
      queuedPrompts: [{ text: "hello", messageUuid: "m-1" }],
    });
    const { initSession } = render(session, false);
    expect(initSession).not.toHaveBeenCalled();
  });

  it("waits for an in-flight init instead of sending another", () => {
    const session = loadedSession({
      initRequestId: "init-1",
      queuedPrompts: [{ text: "hello", messageUuid: "m-1" }],
    });
    const { initSession } = render(session, false);
    expect(initSession).not.toHaveBeenCalled();
  });

  it("retries init for a prompt queued after a refused init", () => {
    const inFlight = loadedSession({
      initRequestId: "init-1",
      queuedPrompts: [{ text: "hello", messageUuid: "m-1" }],
    });
    const { initSession, args, hook } = render(inFlight, false);
    expect(initSession).not.toHaveBeenCalled();
    // The refusal cleared the queue and the in-flight id; a new prompt queues.
    const refusedThenQueued = loadedSession({
      queuedPrompts: [{ text: "again", messageUuid: "m-2" }],
    });
    hook.rerender({ ...args, data: { ...args.data, session: refusedThenQueued } });
    expect(initSession).toHaveBeenCalledTimes(1);
  });

  it("skips init when another view of the session already sent one", () => {
    useWsSessionStore.setState({
      sessions: { "ws-feature-7": loadedSession({ initRequestId: "init-other-view" }) },
    });
    const queued = loadedSession({ queuedPrompts: [{ text: "hello", messageUuid: "m-1" }] });
    const { initSession } = render(queued, true);
    expect(initSession).not.toHaveBeenCalled();
  });

  it("initializes a full session on mount", () => {
    const { initSession } = render(loadedSession(), true);
    expect(initSession).toHaveBeenCalledTimes(1);
  });
});

describe("useWsSessionEffects focus when a workspace is shown again", () => {
  afterEach(() => vi.useRealTimers());

  function renderInWorkspace(activity: WorkspaceActivityController, focusedTabId: string) {
    const refs = {
      agent: { current: { focusPromptBar: vi.fn(), focusActiveInput: vi.fn() } },
      terminal: { current: { activate: vi.fn() } },
      editor: { current: { focusActiveEditor: vi.fn() } },
    };
    const args = {
      sessionId: "ws-feature-7",
      cwd: "/repo",
      featureId: 7,
      data: { session: loadedSession(), effectiveCwd: "/repo", requestSlashCommands: vi.fn() },
      controls: {
        ws: { initSession: vi.fn(), isConnected: true, permissionMode: "default" },
        initializedRef: { current: null },
        claudeProfile: {},
      },
      refs,
      focusedTabId,
      hotkeysEnabled: true,
      autoFocusPrompt: true,
      autoInitSession: false,
    } as unknown as EffectsArgs;
    renderHook(() => useWsSessionEffects(args), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>
      ),
    });
    return refs;
  }

  /** Hide, then show: focus moves one frame after the workspace is on screen. */
  function hideThenShow(activity: WorkspaceActivityController): void {
    act(() => activity.set(false));
    act(() => activity.set(true));
    act(() => void vi.advanceTimersByTime(20));
  }

  it("activates the terminal a conversation was left on", () => {
    vi.useFakeTimers();
    const activity = createWorkspaceActivity(true);
    const refs = renderInWorkspace(activity, "terminal");
    act(() => void vi.advanceTimersByTime(20));
    // On mount the terminal focuses itself.
    expect(refs.terminal.current.activate).not.toHaveBeenCalled();

    hideThenShow(activity);

    expect(refs.terminal.current.activate).toHaveBeenCalledTimes(1);
    expect(refs.agent.current.focusPromptBar).not.toHaveBeenCalled();
  });

  it("focuses the editor a conversation was left on", () => {
    vi.useFakeTimers();
    const activity = createWorkspaceActivity(true);
    const refs = renderInWorkspace(activity, "editor");

    hideThenShow(activity);

    expect(refs.editor.current.focusActiveEditor).toHaveBeenCalledTimes(1);
    expect(refs.agent.current.focusPromptBar).not.toHaveBeenCalled();
  });

  it("takes the prompt back on the agent tab, and leaves focus alone while hidden", () => {
    vi.useFakeTimers();
    const activity = createWorkspaceActivity(false);
    const refs = renderInWorkspace(activity, "agent");
    act(() => void vi.advanceTimersByTime(20));
    expect(refs.agent.current.focusPromptBar).not.toHaveBeenCalled();

    act(() => activity.set(true));
    act(() => void vi.advanceTimersByTime(20));

    expect(refs.agent.current.focusPromptBar).toHaveBeenCalledTimes(1);
  });
});

describe("claudeProfileForPrompt", () => {
  type Controls = Parameters<typeof claudeProfileForPrompt>[0];
  const controls = (activeProviderId: string, supportsProfiles: boolean): Controls =>
    ({
      activeProviderId,
      supportsProfiles,
      claudeProfile: { selectedClaudeProfile: "work" },
    }) as unknown as Controls;

  it("attaches the profile for a provider with profiles", () => {
    expect(claudeProfileForPrompt(controls("claude_code", true))).toBe("work");
  });

  it("drops the profile for a session confirmed on a provider without profiles", () => {
    // `activeProviderId` is the session's confirmed provider once known.
    expect(claudeProfileForPrompt(controls("opencode", false))).toBeUndefined();
  });
});
