import type { AxiosRequestConfig } from "axios";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { customInstance } = vi.hoisted(() => ({
  customInstance: vi.fn(<T>(_config: AxiosRequestConfig): Promise<T> => Promise.resolve({} as T)),
}));

vi.mock("./client", () => ({ customInstance }));

import {
  createFeature,
  getCreateFeatureMutationKey,
  getCreateFeatureMutationOptions,
  getGetAgentCatalogQueryKey,
  getHealthQueryOptions,
  health,
  setWorkspaceSetting,
} from "./generated";

describe("generated API contract", () => {
  beforeEach(() => {
    customInstance.mockClear();
  });

  it("keeps Axios as the explicit request client and forwards GET abort signals", async () => {
    const signal = new AbortController().signal;

    await health(signal);

    expect(customInstance).toHaveBeenCalledWith({
      url: "/api/health",
      method: "GET",
      signal,
    });
  });

  it("keeps JSON request bodies in Axios data for generated mutations", async () => {
    const body = { project_id: 42, title: "Contract test" };
    const signal = new AbortController().signal;

    await createFeature(body, signal);
    await setWorkspaceSetting("loader_style", { value: "spinner" }, signal);

    expect(customInstance).toHaveBeenNthCalledWith(1, {
      url: "/api/features",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: body,
      signal,
    });
    expect(customInstance).toHaveBeenNthCalledWith(2, {
      url: "/api/workspace/settings/loader_style",
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      data: { value: "spinner" },
      signal,
    });
  });

  it("classifies feature creation as a mutation whose variables drive the POST", async () => {
    const body = { project_id: 42, title: "Mutation contract" };
    const options = getCreateFeatureMutationOptions();
    expect(options.mutationKey).toEqual(getCreateFeatureMutationKey());
    expect(options.mutationKey).toEqual(["createFeature"]);
    if (typeof options.mutationFn !== "function")
      throw new Error("expected a generated mutation function");

    await options.mutationFn(
      { data: body },
      {
        client: new QueryClient(),
        meta: undefined,
        mutationKey: options.mutationKey,
      },
    );

    expect(customInstance).toHaveBeenCalledWith({
      url: "/api/features",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: body,
      signal: undefined,
    });
  });

  it("keeps React Query v5 keys parameter-sensitive and forwards query cancellation", async () => {
    const params = { cwd: "/tmp/project", profile: "work" };
    expect(getGetAgentCatalogQueryKey(params)).toEqual(["/api/agent-catalog", params]);

    const options = getHealthQueryOptions();
    const signal = new AbortController().signal;
    if (typeof options.queryFn !== "function")
      throw new Error("expected a generated query function");

    await options.queryFn({ signal } as Parameters<typeof options.queryFn>[0]);

    expect(options.queryKey).toEqual(["/api/health"]);
    expect(customInstance).toHaveBeenCalledWith({
      url: "/api/health",
      method: "GET",
      signal,
    });
  });

  it("preserves a caller's mutation key when the generator supplies a key helper", () => {
    const mutationKey = ["createFeature", { projectId: 42 }] as const;
    const options = getCreateFeatureMutationOptions({ mutation: { mutationKey } });

    expect(options.mutationKey).toBe(mutationKey);
    expect(getCreateFeatureMutationKey()).toEqual(["createFeature"]);
  });
});
