// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/test-utils";
import { getGetAgentSelectionQueryKey } from "./generated";
import {
  useDeleteCodexProfile,
  useSaveCodexProfile,
  useSetActiveCodexProfile,
  useValidateCodexProfile,
} from "./codexProfiles";

const mockCustomInstance = vi.fn();
vi.mock("./client", () => ({
  customInstance: (...args: unknown[]) => mockCustomInstance(...args),
}));

function renderMutation<T>(hook: () => T) {
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: Number.POSITIVE_INFINITY, staleTime: 0 },
    mutations: { retry: false },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { ...renderHook(hook, { wrapper }), invalidate, queryClient };
}

describe("Codex profile API", () => {
  beforeEach(() => {
    mockCustomInstance.mockReset();
    mockCustomInstance.mockImplementation((request: { url: string }) => {
      if (request.url.endsWith("/validate"))
        return Promise.resolve({
          valid: true,
          validation_scope: "local_syntax",
          codex_compatible: null,
          errors: [],
        });
      if (request.url.endsWith("/active"))
        return Promise.resolve({ profiles: [], active_profile_id: null });
      return Promise.resolve({
        id: "work-id",
        name: "Work",
        effective_home: "/tmp/codex",
        env_keys: [],
        env_unset: [],
        is_active: false,
        revision: "r1",
      });
    });
  });

  it("creates a profile without exposing a synthetic CLI --profile argument", async () => {
    const { result } = renderMutation(useSaveCodexProfile);
    await act(async () => {
      await result.current.mutateAsync({
        name: "Work",
        config_path: "/Users/me/.codex-work/config.toml",
        env: { OPENAI_BASE_URL: "https://example.test" },
        env_unset: ["OPENAI_API_KEY"],
      });
    });
    expect(mockCustomInstance).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/codex/profiles",
      data: {
        name: "Work",
        config_path: "/Users/me/.codex-work/config.toml",
        env: { OPENAI_BASE_URL: "https://example.test" },
        env_unset: ["OPENAI_API_KEY"],
      },
    });
  });

  it("preserves selected secret values explicitly on update", async () => {
    const { result, queryClient } = renderMutation(useSaveCodexProfile);
    const matchingCatalog = ["agent-catalog", "/work", "codex_cli", "work-id"] as const;
    const otherCatalog = ["agent-catalog", "/work", "claude_code", "bedrock"] as const;
    const genericProfiles = ["agent-profiles", "codex_cli", "/work"] as const;
    const selection = getGetAgentSelectionQueryKey();
    for (const key of [matchingCatalog, otherCatalog, genericProfiles, selection]) {
      queryClient.setQueryData(key, { cached: true });
    }
    await act(async () => {
      await result.current.mutateAsync({
        id: "work-id",
        name: "Work",
        env: { OPENAI_BASE_URL: "https://new.test" },
        preserve_env_keys: ["OPENAI_API_KEY"],
      });
    });
    expect(mockCustomInstance).toHaveBeenCalledWith({
      method: "PUT",
      url: "/api/codex/profiles/work-id",
      data: {
        name: "Work",
        env: { OPENAI_BASE_URL: "https://new.test" },
        preserve_env_keys: ["OPENAI_API_KEY"],
      },
    });
    expect(queryClient.getQueryState(matchingCatalog)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(genericProfiles)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherCatalog)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(selection)?.isInvalidated).toBe(false);
  });

  it("invalidates every catalog and the real selection key when the active profile changes", async () => {
    const { result, queryClient } = renderMutation(useSetActiveCodexProfile);
    const codexCatalog = ["agent-catalog", "/work", "codex_cli", "work-id"] as const;
    const claudeCatalog = ["agent-catalog", "/work", "claude_code", "bedrock"] as const;
    const selection = getGetAgentSelectionQueryKey();
    for (const key of [codexCatalog, claudeCatalog, selection]) {
      queryClient.setQueryData(key, { cached: true });
    }

    await act(async () => {
      await result.current.mutateAsync("work-id");
    });

    expect(queryClient.getQueryState(codexCatalog)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(claudeCatalog)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(selection)?.isInvalidated).toBe(true);
  });

  it("uses separate validate, default, and delete endpoints", async () => {
    const validation = renderMutation(useValidateCodexProfile);
    const activation = renderMutation(useSetActiveCodexProfile);
    const deletion = renderMutation(useDeleteCodexProfile);
    await act(async () => {
      await validation.result.current.mutateAsync({ name: "Work" });
      await activation.result.current.mutateAsync("work-id");
      await deletion.result.current.mutateAsync("work-id");
    });
    expect(mockCustomInstance).toHaveBeenNthCalledWith(1, {
      method: "POST",
      url: "/api/codex/profiles/validate",
      data: { name: "Work" },
    });
    expect(mockCustomInstance).toHaveBeenNthCalledWith(2, {
      method: "PUT",
      url: "/api/codex/profiles/active",
      data: { profile_id: "work-id" },
    });
    expect(mockCustomInstance).toHaveBeenNthCalledWith(3, {
      method: "DELETE",
      url: "/api/codex/profiles/work-id",
    });
  });

  it("preserves an invalid local validation response with nullable metadata", async () => {
    const response = {
      valid: false,
      validation_scope: "local_syntax",
      codex_compatible: null,
      errors: [
        { field: "config_path", code: "INVALID_CONFIG_PATH", message: "Path must be absolute" },
      ],
      effective_home: null,
      config_exists: false,
      revision: null,
    } as const;
    mockCustomInstance.mockResolvedValueOnce(response);
    const validation = renderMutation(useValidateCodexProfile);
    await act(async () => {
      await expect(
        validation.result.current.mutateAsync({
          name: "Work",
          config_path: "relative/config.toml",
        }),
      ).resolves.toEqual(response);
    });
  });
});
