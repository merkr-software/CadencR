import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook } from "@/test-utils";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry, type SessionEntry } from "@/stores/ws-session-types";
import { claudeProfileForPrompt, useWsSessionEffects } from "./WebSocketSessionFeatureBlockHooks";

vi.mock("@/hooks/useAgentLetterFocus", () => ({ useAgentLetterFocus: vi.fn() }));

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
