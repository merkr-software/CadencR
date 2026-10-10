// @vitest-environment happy-dom
import React from "react";
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useResolvedModel } from "./useResolvedModel";
import type { AgentSelectionResponse, ResolvedSelection } from "../api/generated";

const mockSetModelMutate = vi.fn();
const mockSetProviderMutate = vi.fn();

interface MockCatalogProvider {
  id: string;
  label: string;
  status: string;
  models: unknown;
  default_model?: string;
}

const mockAgentCatalog = vi.fn(
  (): {
    data?: { default_provider?: string; providers?: MockCatalogProvider[] };
  } => ({
    data: {
      default_provider: "claude_code",
      providers: [
        {
          id: "claude_code",
          label: "Claude",
          status: "available",
          models: [] as unknown,
          default_model: "claude-sonnet-4-5",
        },
      ],
    },
  }),
);

const mockUseGetAgentSelection = vi.fn(
  (): { data?: AgentSelectionResponse; error?: unknown; isLoading: boolean } => ({
    data: undefined,
    error: undefined,
    isLoading: true,
  }),
);

vi.mock("../api/agentSelection", () => ({
  useResolvedSelection: () => mockUseGetAgentSelection(),
  sessionSelectionOf: (response: AgentSelectionResponse | undefined): ResolvedSelection | null =>
    response?.selections?.session ?? null,
}));

vi.mock("../api/generated", () => ({
  useSetFeatureModelSetting: vi.fn((opts?: { mutation?: { onSuccess?: () => void } }) => ({
    mutate: (data: unknown) => {
      mockSetModelMutate(data);
      opts?.mutation?.onSuccess?.();
    },
  })),
  getGetFeatureModelSettingsQueryKey: (id: number) => ["features", "modelSettings", id],
  getGetAgentSelectionQueryKey: () => ["/api/agent-runtime/selection"],
}));

vi.mock("../api/agentRuntime", () => ({
  useAgentCatalog: () => mockAgentCatalog(),
  // `useSetFeatureProviderSetting` takes flat callbacks ({ onSuccess }), not a
  // nested `mutation` object — mirror the real contract so the invalidation
  // path is actually exercised.
  useSetFeatureProviderSetting: vi.fn((opts?: { onSuccess?: () => void }) => ({
    mutate: (data: unknown) => {
      mockSetProviderMutate(data);
      opts?.onSuccess?.();
    },
  })),
}));

vi.mock("@/lib/api-errors", () => ({
  toastError: vi.fn(),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient();
  return React.createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useResolvedModel", () => {
  beforeEach(() => {
    mockSetModelMutate.mockClear();
    mockSetProviderMutate.mockClear();
    mockUseGetAgentSelection.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
    });
    mockAgentCatalog.mockReturnValue({
      data: {
        default_provider: "claude_code",
        providers: [
          {
            id: "claude_code",
            label: "Claude",
            status: "available",
            models: [] as unknown,
            default_model: "claude-sonnet-4-5",
          },
        ],
      },
    });
  });

  it("returns null for resolveSelection while the backend has not resolved a selection", () => {
    mockUseGetAgentSelection.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
    });
    const { result } = renderHook(() => useResolvedModel(1, 1), { wrapper });
    expect(result.current.resolveSelection("session")).toBeNull();
  });

  it("returns the backend-resolved pair once the query returns", () => {
    mockUseGetAgentSelection.mockReturnValue({
      data: {
        selections: {
          session: {
            provider_id: "opencode",
            model_id: "lmstudio/qwen-3.6:35b-a3b",
            provider_origin: "feature",
            model_origin: "feature",
          },
        },
      },
      error: undefined,
      isLoading: false,
    });
    const { result } = renderHook(() => useResolvedModel(1, 1), { wrapper });
    expect(result.current.resolveSelection("session")).toEqual({
      providerId: "opencode",
      modelId: "lmstudio/qwen-3.6:35b-a3b",
    });
  });

  it("returns the catalog default model when selection query is pending", () => {
    mockUseGetAgentSelection.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
    });
    const { result } = renderHook(() => useResolvedModel(1, 1), { wrapper });
    expect(result.current.resolveProvider("session")).toBe("claude_code");
    // The mock's default_model is distinct from any hardcoded fallback, so
    // this proves the catalog value (not a literal) is what gets returned.
    expect(result.current.resolveModel("session")).toBe("claude-sonnet-4-5");
  });

  it("returns an empty model id when the catalog has no default model", () => {
    mockAgentCatalog.mockReturnValue({
      data: {
        default_provider: "claude_code",
        providers: [
          { id: "claude_code", label: "Claude", status: "available", models: [] as unknown },
        ],
      },
    });
    const { result } = renderHook(() => useResolvedModel(1, 1), { wrapper });
    expect(result.current.resolveModel("session")).toBe("");
  });

  it("handleModelChange calls setModelMutation.mutate", () => {
    const { result } = renderHook(() => useResolvedModel(1, 1), { wrapper });
    result.current.handleModelChange("session", "claude-3-5-sonnet");
    expect(mockSetModelMutate).toHaveBeenCalledWith({
      id: 1,
      data: { model_type: "session", model: "claude-3-5-sonnet" },
    });
  });

  it("handleProviderChange calls setProviderMutation.mutate", () => {
    const { result } = renderHook(() => useResolvedModel(1, 1), { wrapper });
    result.current.handleProviderChange("session", "opencode");
    expect(mockSetProviderMutate).toHaveBeenCalledWith({
      featureId: 1,
      providerType: "session",
      provider: "opencode",
    });
  });
});
