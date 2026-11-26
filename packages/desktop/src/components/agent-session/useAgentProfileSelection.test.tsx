import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentProfileSelection } from "./useAgentProfileSelection";

const query = vi.fn();
vi.mock("@/api/agentRuntime", () => ({ useAgentProfiles: (...args: unknown[]) => query(...args) }));

describe("useAgentProfileSelection", () => {
  beforeEach(() =>
    query.mockReturnValue({
      data: {
        active_profile: "work",
        default_profile: "work",
        profiles: [{ id: "opaque-id", label: "Work account", is_default: true }],
      },
      isLoading: false,
      isError: false,
    }),
  );

  it("preserves profile labels while sending stable ids", () => {
    const { result } = renderHook(() =>
      useAgentProfileSelection({ providerId: "codex", supportsProfiles: true }),
    );
    expect(result.current.claudeProfiles).toEqual([
      { name: "opaque-id", label: "Work account", env: {} },
    ]);
  });

  it("resets a draft selection when the provider changes", () => {
    const { result, rerender } = renderHook(
      ({ providerId }) => useAgentProfileSelection({ providerId, supportsProfiles: true }),
      { initialProps: { providerId: "codex" } },
    );
    act(() => result.current.handleClaudeProfileChange("opaque-id"));
    query.mockReturnValue({
      data: { active_profile: "claude-default", default_profile: "claude-default", profiles: [] },
      isLoading: false,
      isError: false,
    });
    rerender({ providerId: "claude_code" });
    expect(result.current.selectedClaudeProfile).toBe("claude-default");
  });

  it("waits for backend confirmation for an established session", () => {
    const change = vi.fn();
    const { result } = renderHook(() =>
      useAgentProfileSelection({
        providerId: "codex",
        supportsProfiles: true,
        sessionProfile: "work",
        onSessionProfileChange: change,
      }),
    );
    act(() => result.current.handleClaudeProfileChange("opaque-id"));
    expect(change).toHaveBeenCalledWith("opaque-id");
    expect(result.current.selectedClaudeProfile).toBe("work");
  });

  it.each(["claude_code", "codex_cli"])(
    "omits a profile override when %s profiles fail to load",
    (providerId) => {
      query.mockReturnValue({ data: undefined, isLoading: false, isError: true });
      const { result } = renderHook(() =>
        useAgentProfileSelection({
          providerId,
          supportsProfiles: true,
          sessionProfile: "work",
        }),
      );
      expect(result.current.claudeProfilesError).toBe(true);
      expect(result.current.promptProfile).toBeUndefined();
      expect(result.current.catalogProfile).toBeUndefined();
    },
  );

  it("does not forward a stale profile after a provider switch", () => {
    const { result, rerender } = renderHook(
      ({ providerId }) =>
        useAgentProfileSelection({ providerId, supportsProfiles: true, sessionProfile: "work" }),
      { initialProps: { providerId: "codex" } },
    );
    query.mockReturnValue({
      data: {
        active_profile: "claude-default",
        default_profile: "claude-default",
        profiles: [{ id: "claude-default", label: "Default", is_default: true }],
      },
      isLoading: false,
      isError: false,
    });
    rerender({ providerId: "claude_code" });
    expect(result.current.selectedClaudeProfile).toBe("claude-default");
    expect(result.current.promptProfile).toBeUndefined();
    expect(result.current.catalogProfile).toBeUndefined();
  });
});
