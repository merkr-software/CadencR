import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useClaudeProfileSelection } from "./useClaudeProfileSelection";
import type { ClaudeCodeProfilesResponse } from "../../api/agentRuntime";

const mockProfilesQuery = vi.fn();

vi.mock("../../api/agentRuntime", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/agentRuntime")>("../../api/agentRuntime");
  return {
    ...actual,
    useClaudeCodeProfiles: () => mockProfilesQuery(),
  };
});

function query(data: ClaudeCodeProfilesResponse | undefined) {
  return { data, isLoading: false, isError: false };
}

const PROFILES: ClaudeCodeProfilesResponse["profiles"] = [{ name: "bedrock", env: {} }];

describe("useClaudeProfileSelection", () => {
  beforeEach(() => {
    mockProfilesQuery.mockReset();
  });

  it("adopts the configured active profile for a conversation", () => {
    mockProfilesQuery.mockReturnValue(query({ profiles: PROFILES, active: "bedrock" }));
    const { result } = renderHook(() =>
      useClaudeProfileSelection({ isClaudeProvider: true, wsSessionId: "session-a" }),
    );
    expect(result.current.selectedClaudeProfile).toBe("bedrock");
  });

  it("re-syncs to the active profile when switching to a new conversation", () => {
    // Active profile is already settled and never changes — only the
    // conversation id does. This is the regression for issue #77: a new
    // conversation must still honor the configured default profile.
    mockProfilesQuery.mockReturnValue(query({ profiles: PROFILES, active: "bedrock" }));
    const { result, rerender } = renderHook(
      ({ wsSessionId }) => useClaudeProfileSelection({ isClaudeProvider: true, wsSessionId }),
      { initialProps: { wsSessionId: "session-a" } },
    );
    expect(result.current.selectedClaudeProfile).toBe("bedrock");

    act(() => result.current.handleClaudeProfileChange("default"));
    expect(result.current.selectedClaudeProfile).toBe("default");

    rerender({ wsSessionId: "session-b" });
    expect(result.current.selectedClaudeProfile).toBe("bedrock");
  });

  it("keeps a manual selection when the active profile changes globally", () => {
    mockProfilesQuery.mockReturnValue(query({ profiles: PROFILES, active: "bedrock" }));
    const { result, rerender } = renderHook(() =>
      useClaudeProfileSelection({ isClaudeProvider: true, wsSessionId: "session-a" }),
    );
    act(() => result.current.handleClaudeProfileChange("default"));
    expect(result.current.selectedClaudeProfile).toBe("default");

    // A settings-driven change to the global active profile must not override
    // the user's explicit pick for this conversation.
    mockProfilesQuery.mockReturnValue(query({ profiles: PROFILES, active: "default" }));
    rerender();
    expect(result.current.selectedClaudeProfile).toBe("default");
  });

  it("uses the session profile instead of the globally active profile", () => {
    mockProfilesQuery.mockReturnValue(query({ profiles: PROFILES, active: "default" }));
    const { result, rerender } = renderHook(
      ({ sessionProfile }) =>
        useClaudeProfileSelection({
          isClaudeProvider: true,
          wsSessionId: "session-a",
          sessionProfile,
        }),
      { initialProps: { sessionProfile: "bedrock" as string | undefined } },
    );
    expect(result.current.selectedClaudeProfile).toBe("bedrock");

    mockProfilesQuery.mockReturnValue(query({ profiles: PROFILES, active: "default" }));
    rerender({ sessionProfile: "bedrock" });
    expect(result.current.selectedClaudeProfile).toBe("bedrock");
  });

  it("notifies the session profile setter when the profile changes", () => {
    const onSessionProfileChange = vi.fn();
    mockProfilesQuery.mockReturnValue(query({ profiles: PROFILES, active: "default" }));
    const { result } = renderHook(() =>
      useClaudeProfileSelection({
        isClaudeProvider: true,
        wsSessionId: "session-a",
        sessionProfile: "default",
        onSessionProfileChange,
      }),
    );

    act(() => result.current.handleClaudeProfileChange("bedrock"));

    expect(onSessionProfileChange).toHaveBeenCalledWith("bedrock");
    expect(result.current.selectedClaudeProfile).toBe("bedrock");
  });

  it("falls back to the default profile name when the query has no data yet", () => {
    mockProfilesQuery.mockReturnValue(query(undefined));
    const { result } = renderHook(() =>
      useClaudeProfileSelection({ isClaudeProvider: true, wsSessionId: "session-a" }),
    );
    expect(result.current.selectedClaudeProfile).toBe("default");
  });
});
