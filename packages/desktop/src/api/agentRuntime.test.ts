import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestQueryClient } from "@/test-utils";
import {
  useAgentCatalog,
  useSetActiveClaudeCodeProfile,
  useUpsertClaudeCodeProfile,
  useDeleteClaudeCodeProfile,
} from "./agentRuntime";

const mockCustomInstance = vi.fn();
vi.mock("./client", () => ({
  customInstance: (...args: unknown[]) => mockCustomInstance(...args),
}));

function renderWithSpiedClient<T>(useHook: () => T) {
  const queryClient = createTestQueryClient();
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(useHook, { wrapper });
  return { result, invalidateSpy };
}

describe("Claude Code profile mutations", () => {
  beforeEach(() => {
    mockCustomInstance.mockReset();
    mockCustomInstance.mockResolvedValue({ ok: true });
  });

  // The active profile env feeds the model probe, so switching profiles must
  // refetch the catalog — otherwise the picker keeps the old profile's models
  // (under Bedrock/Vertex even the model ids differ). Regression for issue #43.
  it("invalidates both profiles and the agent catalog when activating a profile", async () => {
    const { result, invalidateSpy } = renderWithSpiedClient(() => useSetActiveClaudeCodeProfile());
    await act(async () => {
      await result.current.mutateAsync({ name: "bedrock" });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["claude-code", "profiles"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["agent-catalog"] });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("invalidates both profiles and the agent catalog when upserting a profile", async () => {
    mockCustomInstance.mockResolvedValue({ name: "bedrock", env: {} });
    const { result, invalidateSpy } = renderWithSpiedClient(() => useUpsertClaudeCodeProfile());
    await act(async () => {
      await result.current.mutateAsync({ name: "bedrock", env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["claude-code", "profiles"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["agent-catalog"] });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("invalidates both profiles and the agent catalog when deleting a profile", async () => {
    const { result, invalidateSpy } = renderWithSpiedClient(() => useDeleteClaudeCodeProfile());
    await act(async () => {
      await result.current.mutateAsync({ name: "bedrock" });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["claude-code", "profiles"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["agent-catalog"] });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });
});

describe("useAgentCatalog profile scoping", () => {
  beforeEach(() => {
    mockCustomInstance.mockReset();
    mockCustomInstance.mockResolvedValue({ default_provider: "claude_code", providers: [] });
  });

  // Issue #76: switching the prompt-area Claude profile must refetch the model
  // list for that profile. A distinct `profile` makes a distinct cache key and
  // request, so the picker shows the chosen profile's models, not stale ones.
  it("sends the selected profile and keys the cache by it", async () => {
    const { result } = renderWithSpiedClient(() =>
      useAgentCatalog({ cwd: "/work", profile: "bedrock" }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockCustomInstance).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/agent-catalog",
      params: { cwd: "/work", profile: "bedrock" },
    });
  });

  it("omits the profile param when none is selected so the backend uses the active profile", async () => {
    const { result } = renderWithSpiedClient(() => useAgentCatalog({ cwd: "/work" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockCustomInstance).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/agent-catalog",
      params: { cwd: "/work" },
    });
  });
});
