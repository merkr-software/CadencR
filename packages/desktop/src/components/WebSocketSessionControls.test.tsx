import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test-utils";
import { PROVIDER_IDS } from "@/lib/providers";
import type { useAccessModeSetting } from "@/hooks/useAccessModeSetting";

const mocks = vi.hoisted(() => ({
  useAgentCatalog: vi.fn(),
  useWebSocketSession: vi.fn(),
  useAgentProfileSelection: vi.fn(),
  useAccessModeSetting: vi.fn(),
  projectSettingMutate: vi.fn(),
}));

vi.mock("@/api/agentRuntime", () => ({ useAgentCatalog: mocks.useAgentCatalog }));
vi.mock("@/hooks/useWebSocketSession", () => ({
  useWebSocketSession: mocks.useWebSocketSession,
}));
vi.mock("@/components/agent-session/useAgentProfileSelection", () => ({
  useAgentProfileSelection: mocks.useAgentProfileSelection,
}));
vi.mock("@/contexts/ResolvedModelContext", () => ({
  useResolvedModelContext: () => ({
    resolveProvider: () => PROVIDER_IDS.CLAUDE_CODE,
    resolveModel: () => "claude-sonnet",
  }),
}));
vi.mock("@/api/generated", () => ({
  getGetProjectSettingsQueryKey: (id: number) => [`/api/projects/${id}/settings`],
  useGetProjectSettings: () => ({ data: {} }),
  useSetProjectSetting: () => ({ mutate: mocks.projectSettingMutate, isPending: false }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/useEnabledOptInModes", () => ({ useEnabledOptInModes: () => [] }));
vi.mock("@/hooks/useAccessModeSetting", () => ({
  useAccessModeSetting: mocks.useAccessModeSetting,
}));
vi.mock("@/components/WebSocketSessionPermissionMode", () => ({
  EMPTY_PROVIDER_MODES: [],
  usePermissionModeToggle: () => vi.fn(),
  usePermissionModeSet: () => vi.fn(),
}));

import { useSessionControls } from "./WebSocketSessionControls";

function ws(currentProviderId?: string) {
  return {
    currentSelection: currentProviderId
      ? { providerId: currentProviderId, modelId: "model" }
      : null,
    currentProfile: undefined,
    setProfile: vi.fn(),
    blocks: [],
    runtimeSessionId: "",
    accessMode: "default",
    setAccessMode: vi.fn(),
    sendPrompt: vi.fn(),
    sessionConfigSupported: true,
    sessionConfigLoading: false,
    sessionConfigError: null,
    requestSessionConfig: vi.fn(),
  };
}

describe("useSessionControls catalog scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAgentCatalog.mockReturnValue({ data: { providers: [] } });
    mocks.useAccessModeSetting.mockReturnValue(accessSetting());
    mocks.useAgentProfileSelection.mockReturnValue({
      catalogProfile: undefined,
      selectedClaudeProfile: "default",
      activeClaudeProfile: "default",
      claudeProfiles: [],
      claudeProfilesLoading: false,
      claudeProfilesError: false,
      handleClaudeProfileChange: vi.fn(),
    });
  });

  it("switches to a mode that moves the project default only once the backend saves it", () => {
    mocks.useWebSocketSession.mockReturnValue(ws());
    mocks.projectSettingMutate.mockReset();
    const { result } = renderHook(() => useSessionControls("session", 1, 1, "/work"));
    expect(result.current.worktreeMode).toBe("from_branch_worktree");

    act(() => result.current.setWorktreeMode("on_branch"));
    expect(mocks.projectSettingMutate).toHaveBeenCalledWith(
      { id: 1, data: { key: "default_worktree_mode", value: "skip" } },
      expect.anything(),
    );
    expect(result.current.worktreeMode).toBe("from_branch_worktree");

    const failed = mocks.projectSettingMutate.mock.calls[0]?.[1] as { onError: (e: Error) => void };
    act(() => failed.onError(new Error("disk full")));
    expect(result.current.worktreeMode).toBe("from_branch_worktree");

    act(() => result.current.setWorktreeMode("on_branch"));
    const saved = mocks.projectSettingMutate.mock.calls[1]?.[1] as { onSuccess: () => void };
    act(() => saved.onSuccess());
    expect(result.current.worktreeMode).toBe("on_branch");
  });

  it("applies a branch-specific mode at once: it is the conversation's pick, not a setting", () => {
    mocks.useWebSocketSession.mockReturnValue(ws());
    mocks.projectSettingMutate.mockReset();
    const { result } = renderHook(() => useSessionControls("session", 1, 1, "/work"));
    act(() => result.current.setWorktreeMode("from_branch"));
    expect(result.current.worktreeMode).toBe("from_branch");
    expect(mocks.projectSettingMutate).not.toHaveBeenCalled();
  });

  it("queues input during compaction and restores steering when it finishes", () => {
    const session = { ...ws("codex_cli"), isCompacting: true };
    mocks.useWebSocketSession.mockReturnValue(session);
    mocks.useAgentCatalog.mockReturnValue({
      data: { providers: [{ id: "codex_cli", steering_acknowledged: true, models: [] }] },
    });
    const { result, rerender } = renderHook(() => useSessionControls("session", 1, 1, "/work"));
    expect(result.current.steeringAcknowledged).toBe(false);
    mocks.useWebSocketSession.mockReturnValue({ ...session, isCompacting: false });
    rerender();
    expect(result.current.steeringAcknowledged).toBe(true);
  });

  it("deduplicates the runtime catalog with the unscoped base query when no profile is selected", () => {
    mocks.useWebSocketSession.mockReturnValue(ws());
    renderHook(() => useSessionControls("session", 1, 1, "/work"));

    expect(mocks.useAgentCatalog).toHaveBeenNthCalledWith(1, {
      cwd: "/work",
      enabled: undefined,
    });
    expect(mocks.useAgentCatalog).toHaveBeenNthCalledWith(2, {
      cwd: "/work",
      provider: undefined,
      profile: undefined,
      enabled: true,
      staleTime: 30_000,
    });
  });

  it("pairs a selected profile with the confirmed session provider", () => {
    mocks.useWebSocketSession.mockReturnValue(ws(PROVIDER_IDS.CODEX_CLI));
    mocks.useAgentCatalog.mockReturnValueOnce({
      data: {
        providers: [
          {
            id: PROVIDER_IDS.CODEX_CLI,
            profile_capability: { supports_config_inheritance: true },
          },
        ],
      },
    });
    mocks.useAgentProfileSelection.mockReturnValue({
      catalogProfile: "non-active-profile",
      selectedClaudeProfile: "non-active-profile",
      activeClaudeProfile: "default",
      claudeProfiles: [],
      claudeProfilesLoading: false,
      claudeProfilesError: false,
      handleClaudeProfileChange: vi.fn(),
    });

    renderHook(() => useSessionControls("session", 1, 1, "/work"));

    expect(mocks.useAgentCatalog).toHaveBeenNthCalledWith(2, {
      cwd: "/work",
      provider: PROVIDER_IDS.CODEX_CLI,
      profile: "non-active-profile",
      enabled: true,
      staleTime: 30_000,
    });
  });

  it("applies the displayed access default to an empty initialized session before sending", () => {
    const session = ws(PROVIDER_IDS.CODEX_CLI);
    mocks.useWebSocketSession.mockReturnValue(session);
    mocks.useAccessModeSetting.mockReturnValue(accessSetting({ globalAccessMode: "autoReview" }));

    const { result } = renderHook(() => useSessionControls("session", 1, 1, "/work"));

    expect(result.current.accessMode).toBe("autoReview");
    expect(session.setAccessMode).not.toHaveBeenCalled();
    result.current.ws.sendPrompt("first message");

    expect(session.setAccessMode).toHaveBeenCalledWith("autoReview");
    expect(session.sendPrompt).toHaveBeenCalledWith("first message");
    expect(session.setAccessMode.mock.invocationCallOrder[0]).toBeLessThan(
      session.sendPrompt.mock.invocationCallOrder[0],
    );
  });

  it("records the first-prompt choice even when it matches the pre-init seed", () => {
    const session = ws(PROVIDER_IDS.CODEX_CLI);
    mocks.useWebSocketSession.mockReturnValue(session);

    const { result } = renderHook(() => useSessionControls("session", 1, 1, "/work"));
    result.current.ws.sendPrompt("first message", { claudeProfile: "selected-profile" });

    expect(session.setAccessMode).toHaveBeenCalledWith("default");
    expect(session.sendPrompt).toHaveBeenCalledWith("first message", {
      claudeProfile: "selected-profile",
    });
    expect(session.setAccessMode.mock.invocationCallOrder[0]).toBeLessThan(
      session.sendPrompt.mock.invocationCallOrder[0],
    );
  });

  it("repairs the session mode when the chosen chip already matches the workspace default", () => {
    const session = ws(PROVIDER_IDS.CODEX_CLI);
    const setting = accessSetting({ globalAccessMode: "autoReview" });
    mocks.useWebSocketSession.mockReturnValue(session);
    mocks.useAccessModeSetting.mockReturnValue(setting);

    const { result } = renderHook(() => useSessionControls("session", 1, 1, "/work"));
    result.current.handleAccessModeChange("autoReview");

    expect(session.setAccessMode).toHaveBeenCalledWith("autoReview");
    expect(setting.handleAccessModeChange).not.toHaveBeenCalled();
  });

  it.each([{ isLoading: true }, { isPending: true }, { isError: true }])(
    "does not synchronize an unsettled access default: %j",
    (state) => {
      const session = { ...ws(PROVIDER_IDS.CODEX_CLI), accessMode: "autoReview" };
      mocks.useWebSocketSession.mockReturnValue(session);
      mocks.useAccessModeSetting.mockReturnValue(accessSetting(state));

      const { result } = renderHook(() => useSessionControls("session", 1, 1, "/work"));
      result.current.ws.sendPrompt("message from another tab");

      expect(session.setAccessMode).not.toHaveBeenCalled();
      expect(session.sendPrompt).toHaveBeenCalledWith("message from another tab");
      expect(result.current.accessMode).toBe("autoReview");
      expect(result.current.isAccessModePending).toBe(!state.isError);
    },
  );

  it("preserves the session access mode after its first message", () => {
    const session = { ...ws(PROVIDER_IDS.CODEX_CLI), runtimeSessionId: "thread-1" };
    mocks.useWebSocketSession.mockReturnValue(session);
    mocks.useAccessModeSetting.mockReturnValue(accessSetting({ globalAccessMode: "autoReview" }));

    const { result } = renderHook(() => useSessionControls("session", 1, 1, "/work"));
    result.current.ws.sendPrompt("next message");

    expect(result.current.accessMode).toBe("default");
    expect(result.current.isAccessModePending).toBe(false);
    expect(session.setAccessMode).not.toHaveBeenCalled();
    expect(result.current.ws).toBe(session);
  });

  it("preserves a confirmed first message while the runtime id is still arriving", () => {
    const session = {
      ...ws(PROVIDER_IDS.CODEX_CLI),
      blocks: [{ id: "message-1", type: "user", content: "first message" }],
    };
    mocks.useWebSocketSession.mockReturnValue(session);
    mocks.useAccessModeSetting.mockReturnValue(accessSetting({ globalAccessMode: "autoReview" }));

    const { result } = renderHook(() => useSessionControls("session", 1, 1, "/work"));
    result.current.ws.sendPrompt("next message");

    expect(session.setAccessMode).not.toHaveBeenCalled();
    expect(result.current.accessMode).toBe("default");
  });

  it("preserves providers without access modes", () => {
    const session = ws(PROVIDER_IDS.CLAUDE_CODE);
    mocks.useWebSocketSession.mockReturnValue(session);
    mocks.useAccessModeSetting.mockReturnValue(
      accessSetting({ providerLabel: null, globalAccessMode: "autoReview" }),
    );

    const { result } = renderHook(() => useSessionControls("session", 1, 1, "/work"));
    result.current.ws.sendPrompt("first message");

    expect(result.current.accessMode).toBe("default");
    expect(session.setAccessMode).not.toHaveBeenCalled();
    expect(session.sendPrompt).toHaveBeenCalledWith("first message");
    expect(result.current.ws).toBe(session);
  });

  it("keeps the send action stable when the session snapshot changes", () => {
    const session = ws(PROVIDER_IDS.CODEX_CLI);
    mocks.useWebSocketSession.mockReturnValue(session);
    const { result, rerender } = renderHook(() => useSessionControls("session", 1, 1, "/work"));
    const sendPrompt = result.current.ws.sendPrompt;

    mocks.useWebSocketSession.mockReturnValue({ ...session, fastMode: true });
    rerender();

    expect(result.current.ws.sendPrompt).toBe(sendPrompt);
  });
});

function accessSetting(overrides: Partial<ReturnType<typeof useAccessModeSetting>> = {}) {
  return {
    globalAccessMode: "default",
    isError: false,
    isLoading: false,
    isPending: false,
    providerLabel: "Codex",
    handleAccessModeChange: vi.fn(),
    ...overrides,
  };
}
