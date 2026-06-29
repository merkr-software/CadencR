import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUseClaudeCodeProfiles = vi.fn();
vi.mock("../../api/agentRuntime", async (importActual) => {
  const actual = await importActual<typeof import("../../api/agentRuntime")>();
  return {
    ...actual,
    useClaudeCodeProfiles: (...args: unknown[]) => mockUseClaudeCodeProfiles(...args),
  };
});

import { useClaudeProfileSelection } from "./useClaudeProfileSelection";

function mockActiveProfile(active: string): void {
  mockUseClaudeCodeProfiles.mockReturnValue({
    data: {
      active,
      profiles: [
        { name: "bedrock", env: {} },
        { name: "anthropic", env: {} },
      ],
    },
    isLoading: false,
    isError: false,
  });
}

// Issue #76: the prompt-area profile selector must refresh the model list for
// the chosen profile. `catalogProfile` is what scopes the agent-catalog probe,
// so it must track an explicit non-active selection — and stay undefined
// otherwise so the default state never triggers a redundant model probe.
describe("useClaudeProfileSelection catalogProfile", () => {
  beforeEach(() => {
    mockUseClaudeCodeProfiles.mockReset();
  });

  it("leaves catalogProfile undefined while the selection matches the active profile", () => {
    mockActiveProfile("bedrock");
    const { result } = renderHook(() => useClaudeProfileSelection({ isClaudeProvider: true }));
    expect(result.current.selectedClaudeProfile).toBe("bedrock");
    expect(result.current.catalogProfile).toBeUndefined();
  });

  it("scopes catalogProfile to an explicitly chosen non-active profile", () => {
    mockActiveProfile("bedrock");
    const { result } = renderHook(() => useClaudeProfileSelection({ isClaudeProvider: true }));
    act(() => result.current.handleClaudeProfileChange("anthropic"));
    expect(result.current.selectedClaudeProfile).toBe("anthropic");
    expect(result.current.catalogProfile).toBe("anthropic");
  });

  it("clears catalogProfile when switching back to the active profile", () => {
    mockActiveProfile("bedrock");
    const { result } = renderHook(() => useClaudeProfileSelection({ isClaudeProvider: true }));
    act(() => result.current.handleClaudeProfileChange("anthropic"));
    act(() => result.current.handleClaudeProfileChange("bedrock"));
    expect(result.current.catalogProfile).toBeUndefined();
  });
});
