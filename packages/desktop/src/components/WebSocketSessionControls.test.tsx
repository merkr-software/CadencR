import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@/test-utils";
import { PROVIDER_IDS } from "@/lib/providers";

const mocks = vi.hoisted(() => ({
  useAgentCatalog: vi.fn(),
  useWebSocketSession: vi.fn(),
  useAgentProfileSelection: vi.fn(),
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
  useGetProjectSettings: () => ({ data: {} }),
  useSetProjectSetting: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/useEnabledOptInModes", () => ({ useEnabledOptInModes: () => [] }));
vi.mock("@/hooks/useAccessModeSetting", () => ({
  useAccessModeSetting: () => ({
    globalAccessMode: "default",
    isPending: false,
    handleAccessModeChange: vi.fn(),
  }),
}));
vi.mock("@/components/WebSocketSessionPermissionMode", () => ({
  EMPTY_PROVIDER_MODES: [],
  usePermissionModeToggle: () => vi.fn(),
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
});
