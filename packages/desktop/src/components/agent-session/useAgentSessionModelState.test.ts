import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  MODEL_CATALOG_LOADING_LABEL,
  useAgentSessionModelState,
} from "./useAgentSessionModelState";
import type { AgentCatalog } from "@/api/agentRuntime";

const catalog: AgentCatalog = {
  default_provider: "claude_code",
  providers: [
    {
      id: "claude_code",
      label: "Claude",
      status: "available",
      origin: "built_in",
      default_model: "opus",
      models: [{ id: "opus", label: "Opus" }],
    },
    {
      id: "opencode",
      label: "OpenCode",
      status: "available",
      origin: "built_in",
      default_model: "lmstudio/qwen-3.6:35b-a3b",
      models: [{ id: "lmstudio/qwen-3.6:35b-a3b", label: "Qwen 3.6" }],
    },
    {
      id: "codex_cli",
      label: "Codex",
      status: "available",
      origin: "built_in",
      default_model: "gpt-5.6-sol",
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", supports_fast_mode: true },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", supports_fast_mode: false },
      ],
    },
  ],
};

describe("useAgentSessionModelState.canChangeProvider", () => {
  it("shows a loading label instead of a fallback model before catalog data arrives", () => {
    const { result } = renderHook(() =>
      useAgentSessionModelState({
        agentCatalog: undefined,
        currentProviderId: "opencode",
        currentModelId: "default/default",
        onProviderChange: () => {},
        hasConversation: false,
      }),
    );
    expect(result.current.currentModelLabel).toBe(MODEL_CATALOG_LOADING_LABEL);
    expect(result.current.modelSelectionStatus).toBe("catalog-loading");
    expect(result.current.visibleModels).toEqual([]);
  });

  it("shows loading until the backend confirms a provider and model pair", () => {
    const { result } = renderHook(() =>
      useAgentSessionModelState({
        agentCatalog: catalog,
        currentProviderId: "",
        currentModelId: "",
        hasConversation: false,
      }),
    );
    expect(result.current.currentModelLabel).toBe(MODEL_CATALOG_LOADING_LABEL);
    expect(result.current.modelSelectionStatus).toBe("selection-pending");
    expect(result.current.supportedThinkingEfforts).toEqual([]);
  });

  it("does not infer a provider when the confirmed fields disagree", () => {
    const { result } = renderHook(() =>
      useAgentSessionModelState({
        agentCatalog: catalog,
        currentProviderId: "claude_code",
        currentModelId: "lmstudio/qwen-3.6:35b-a3b",
        runtimeProvider: "opencode",
        hasConversation: false,
      }),
    );
    expect(result.current.activeProviderId).toBe("claude_code");
    expect(result.current.currentModelLabel).toBe(MODEL_CATALOG_LOADING_LABEL);
    expect(result.current.modelSelectionStatus).toBe("selection-pending");
  });

  it("does not show a Claude alias under OpenCode", () => {
    const { result } = renderHook(() =>
      useAgentSessionModelState({
        agentCatalog: catalog,
        currentProviderId: "opencode",
        currentModelId: "opus",
        runtimeProvider: "opencode",
        hasConversation: false,
      }),
    );
    expect(result.current.activeProviderId).toBe("opencode");
    expect(result.current.currentModelLabel).toBe(MODEL_CATALOG_LOADING_LABEL);
    expect(result.current.modelSelectionStatus).toBe("selection-pending");
  });

  it("allows provider change on a fresh conversation", () => {
    const { result } = renderHook(() =>
      useAgentSessionModelState({
        agentCatalog: catalog,
        currentProviderId: "claude_code",
        currentModelId: "opus",
        onProviderChange: () => {},
        hasConversation: false,
      }),
    );
    expect(result.current.canChangeProvider).toBe(true);
    expect(result.current.modelSelectionStatus).toBe("ready");
  });

  it("locks the provider once the conversation has any block", () => {
    const { result } = renderHook(() =>
      useAgentSessionModelState({
        agentCatalog: catalog,
        currentProviderId: "claude_code",
        currentModelId: "opus",
        onProviderChange: () => {},
        hasConversation: true,
      }),
    );
    expect(result.current.canChangeProvider).toBe(false);
  });

  it("stays locked when no onProviderChange handler is wired", () => {
    const { result } = renderHook(() =>
      useAgentSessionModelState({
        agentCatalog: catalog,
        currentProviderId: "claude_code",
        currentModelId: "opus",
        hasConversation: false,
      }),
    );
    expect(result.current.canChangeProvider).toBe(false);
  });

  it("ignores stale providers that are no longer selectable", () => {
    const { result } = renderHook(() =>
      useAgentSessionModelState({
        agentCatalog: catalog,
        currentProviderId: "cursor",
        runtimeProvider: "claude_code",
        hasConversation: false,
      }),
    );
    expect(result.current.activeProviderId).toBe("claude_code");
    expect(result.current.visibleModels).toEqual([{ id: "opus", label: "Opus" }]);
  });

  it("falls back to the catalog default when runtime provider is stale", () => {
    const { result } = renderHook(() =>
      useAgentSessionModelState({
        agentCatalog: catalog,
        runtimeProvider: "cursor",
        hasConversation: false,
      }),
    );
    expect(result.current.activeProviderId).toBe("claude_code");
  });

  it("exposes fast mode only when the confirmed model advertises it", () => {
    const { result, rerender } = renderHook(
      ({ modelId }) =>
        useAgentSessionModelState({
          agentCatalog: catalog,
          currentProviderId: "codex_cli",
          currentModelId: modelId,
          hasConversation: false,
        }),
      { initialProps: { modelId: "gpt-5.6-sol" } },
    );

    expect(result.current.supportsFastMode).toBe(true);

    rerender({ modelId: "gpt-5.4-mini" });
    expect(result.current.supportsFastMode).toBe(false);
  });
});
