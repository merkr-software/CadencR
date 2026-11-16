import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@/test-utils";
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
      permissionMode: "default",
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
