import { render } from "@/test-utils";
import type { UnifiedAgentEntry } from "@/api/generated";
import type { AgentBlockData } from "@/components/AgentBlock";
import { createSessionEntry } from "@/stores/ws-session-types";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { UnifiedAgentCard } from "./UnifiedAgentCard";

const mocks = vi.hoisted(() => ({
  WebSocketSessionFeatureBlock: vi.fn(() => <div data-testid="ws-block" />),
  togglePin: vi.fn(),
  navigate: vi.fn(),
  shortcutCallback: null as ((e: KeyboardEvent) => void) | null,
  shortcutEnabled: true,
}));

vi.mock("@/components/WebSocketSessionFeatureBlock", () => ({
  WebSocketSessionFeatureBlock: mocks.WebSocketSessionFeatureBlock,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/hooks/useShortcut", () => ({
  useShortcut: (
    _id: string,
    callback: (e: KeyboardEvent) => void,
    options?: { enabled?: boolean },
  ) => {
    mocks.shortcutCallback = callback;
    mocks.shortcutEnabled = options?.enabled ?? true;
  },
}));

vi.mock("@/contexts/ResolvedModelContext", () => ({
  ResolvedModelProvider: ({ children }: { children: ReactNode }) => children,
  useResolvedModelContext: () => ({
    resolveProvider: () => "claude_code",
    resolveModel: () => "claude-opus-4-5",
    resolveModelThinkingEffort: () => undefined,
    setModelThinkingEffort: () => undefined,
    handleProviderChange: () => undefined,
    handleModelChange: () => undefined,
  }),
}));

vi.mock("@/components/useUnifiedAgentPinControls", () => ({
  useUnifiedAgentPinControls: () => ({ isPending: false, toggle: mocks.togglePin }),
}));

vi.mock("@/components/EmbeddedFeatureHeader", () => ({
  EmbeddedFeatureHeader: () => null,
}));

function makeEntry(overrides: Partial<UnifiedAgentEntry["session"]> = {}): UnifiedAgentEntry {
  return {
    agent_created_at: "2026-05-04T00:00:00Z",
    feature: {
      created_at: "2026-05-04T00:00:00Z",
      id: 7,
      title: "Session feature",
      type: "ws-session",
    },
    is_pinned: false,
    last_activity_at: "2026-05-04T00:00:00Z",
    project: { id: 3, name: "Project", path: "/repo" },
    session: {
      agentType: "session",
      blocks: [],
      contextWindow: null,
      draftPrompt: null,
      hasFileChanges: false,
      hasMore: false,
      inputTokens: 0,
      isIncremental: false,
      maxMessageId: 0,
      model: null,
      oldestMessageId: null,
      outputTokens: 0,
      pendingPermission: null,
      pendingQuestions: null,
      permissionMode: "default",
      accessMode: "default",
      resumable: false,
      runtimeProvider: null,
      runtimeSessionId: null,
      sessionDbId: 42,
      status: "idle",
      subprocessId: null,
      todos: null,
      toolCallUpdates: null,
      wasCompacted: false,
      ...overrides,
    },
  };
}

describe("UnifiedAgentCard ws-session hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shortcutCallback = null;
    mocks.shortcutEnabled = true;
    useWsSessionStore.setState({ sessions: {} });
  });

  it("hydrates an empty embedded session from the unified polling snapshot", () => {
    render(
      <UnifiedAgentCard
        entry={makeEntry({ status: "running", model: "model-a", runtimeProvider: "codex_cli" })}
        index={0}
        isActive={false}
        onActivate={vi.fn()}
        onExcludeAgent={vi.fn()}
      />,
    );

    const session = useWsSessionStore.getState().sessions["ws-feature-7"];
    expect(session?.persistedLoaded).toBe(true);
    // REST status still seeds the lifecycle so cross-feature consumers
    // (powerSaveBlocker, app-close confirmation, "Stop all agents")
    // detect agents the user hasn't opened yet. The badge itself reads
    // from `session-status-store`; this seed is overwritten the moment
    // WS turn events arrive.
    expect(session?.lifecycle).toEqual({ phase: "active" });
    expect(session?.currentSelection).toEqual({ providerId: "codex_cli", modelId: "model-a" });
  });

  it("does not overwrite live WS state when the session is already loaded", () => {
    // Regression guard: re-applying the REST snapshot over a live WS
    // session was clobbering `pendingPermission` / `pendingQuestions` /
    // `pendingPlanApproval`. The plan-approval gate would flip into a
    // permission gate (and approving it would mistakenly approve the
    // plan); a live question form would disappear when the user
    // navigated to the unified grid. The hydration must no-op once the
    // WS handler owns the session.
    const liveBlocks: AgentBlockData[] = [{ id: "live", type: "text", content: "streaming" }];
    const livePermission = {
      toolName: "LivePerm",
      input: {},
      description: "live",
      pattern: "live",
      requestId: "live-1",
    };
    useWsSessionStore.setState({
      sessions: {
        "ws-feature-7": {
          ...createSessionEntry(),
          blocks: liveBlocks,
          rootBlocks: liveBlocks,
          lifecycle: { phase: "active" },
          persistedLoaded: true,
          pendingPermission: livePermission,
          pendingRequestId: "live-1",
          currentSelection: { providerId: "claude_code", modelId: "live-model" },
          hasFileChanges: false,
        },
      },
    });

    render(
      <UnifiedAgentCard
        entry={makeEntry({
          hasFileChanges: true,
          model: "model-b",
          pendingPermission: {
            toolName: "Bash",
            input: { command: "git status" },
            description: "Run git status",
            pattern: "git status",
            requestId: "perm-1",
          },
          permissionMode: "bypassPermissions",
          runtimeProvider: "opencode",
          status: "running",
        })}
        index={0}
        isActive
        onActivate={vi.fn()}
        onExcludeAgent={vi.fn()}
      />,
    );

    const session = useWsSessionStore.getState().sessions["ws-feature-7"];
    // Every field below was set by the WS handler and must survive.
    expect(session?.blocks).toBe(liveBlocks);
    expect(session?.pendingPermission).toBe(livePermission);
    expect(session?.pendingRequestId).toBe("live-1");
    expect(session?.lifecycle).toEqual({ phase: "active" });
    expect(session?.currentSelection).toEqual({
      providerId: "claude_code",
      modelId: "live-model",
    });
    expect(session?.hasFileChanges).toBe(false);
  });
});

describe("UnifiedAgentCard CMD+O shortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shortcutCallback = null;
    mocks.shortcutEnabled = true;
    useWsSessionStore.setState({ sessions: {} });
  });

  it("navigates to the feature page when the shortcut fires", () => {
    render(
      <UnifiedAgentCard
        entry={makeEntry()}
        index={0}
        isActive
        onActivate={vi.fn()}
        onExcludeAgent={vi.fn()}
      />,
    );
    const event = new KeyboardEvent("keydown");
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    mocks.shortcutCallback?.(event);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/features/$featureId",
      params: { projectId: "3", featureId: "7" },
    });
  });

  it("is disabled when the card is not active so only one listener fires per grid", () => {
    render(
      <UnifiedAgentCard
        entry={makeEntry()}
        index={0}
        isActive={false}
        onActivate={vi.fn()}
        onExcludeAgent={vi.fn()}
      />,
    );
    expect(mocks.shortcutEnabled).toBe(false);
  });
});

describe("UnifiedAgentCard exclude action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWsSessionStore.setState({ sessions: {} });
  });

  it("invokes onExcludeAgent with the feature title", () => {
    const onExcludeAgent = vi.fn();
    render(
      <UnifiedAgentCard
        entry={makeEntry()}
        index={0}
        isActive
        onActivate={vi.fn()}
        onExcludeAgent={onExcludeAgent}
      />,
    );
    const calls = mocks.WebSocketSessionFeatureBlock.mock.calls as unknown as Array<
      [{ onExclude?: () => void }]
    >;
    calls[0]?.[0]?.onExclude?.();
    expect(onExcludeAgent).toHaveBeenCalledWith("Session feature");
  });
});
