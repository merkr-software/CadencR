import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSelectionResponse } from "@/api/generated";
import { useProjectRuntimeSelection } from "./useProjectRuntimeSelection";

const mocks = vi.hoisted(() => ({
  selection:
    vi.fn<() => { data?: AgentSelectionResponse; isLoading: boolean; isPending: boolean }>(),
}));

vi.mock("@/api/generated", () => ({
  useGetAgentSelection: () => mocks.selection(),
}));

vi.mock("@/api/agentRuntime", () => ({
  useAgentCatalog: () => ({
    data: {
      default_provider: "test-provider",
      providers: [{ id: "test-provider", default_model: "default-model" }],
    },
    isLoading: false,
  }),
}));

function resolvedSelection(providerId = "test-provider", modelId = "chosen-model") {
  return {
    data: {
      selections: {
        session: {
          provider_id: providerId,
          model_id: modelId,
          provider_origin: "project" as const,
          model_origin: "project" as const,
        },
      },
    },
    isLoading: false,
    isPending: false,
  };
}

describe("useProjectRuntimeSelection", () => {
  beforeEach(() => {
    mocks.selection.mockReset();
    mocks.selection.mockImplementation(() => resolvedSelection());
  });

  it("preserves identity when query objects change but selection values do not", () => {
    const { result, rerender } = renderHook(() => useProjectRuntimeSelection(1));
    const selection = result.current;

    rerender();

    expect(result.current).toBe(selection);
    expect(result.current).toEqual({
      providerId: "test-provider",
      modelId: "chosen-model",
      isLoading: false,
    });
  });

  it.each([
    ["another-provider", "chosen-model"],
    ["test-provider", "another-model"],
  ])("updates when the resolved pair becomes %s / %s", (providerId, modelId) => {
    const { result, rerender } = renderHook(() => useProjectRuntimeSelection(1));
    const selection = result.current;

    mocks.selection.mockReturnValue(resolvedSelection(providerId, modelId));
    rerender();

    expect(result.current).not.toBe(selection);
    expect(result.current).toEqual({ providerId, modelId, isLoading: false });
  });

  it("preserves fallback identity and updates when only loading changes", () => {
    mocks.selection.mockReturnValue({ isLoading: true, isPending: true });
    const { result, rerender } = renderHook(() => useProjectRuntimeSelection(1));
    const fallback = result.current;

    rerender();
    expect(result.current).toBe(fallback);
    expect(result.current.isLoading).toBe(true);

    mocks.selection.mockReturnValue(resolvedSelection("test-provider", "default-model"));
    rerender();

    expect(result.current).not.toBe(fallback);
    expect(result.current).toEqual({ ...fallback, isLoading: false });
  });
});
