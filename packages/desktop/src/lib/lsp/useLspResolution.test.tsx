// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { customInstance } from "@/api/client";
import { useLspResolution } from "./useLspResolution";
import { lspCatalogQuery } from "@/hooks/useLspMarketplace";

vi.mock("@/api/client", () => ({ customInstance: vi.fn() }));
const resolved = {
  language_id: "custom",
  servers: [],
  candidates: [],
  primary: null,
  linters: [],
  ignored: false,
  primary_disabled: false,
  suggestions: [],
  error: null,
};

describe("editor catalog acquisition outside the marketplace", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);
  it("keeps resolution independent of catalog latency, then refreshes suggestions once shared acquisition finishes", async () => {
    let finishCatalog: (value: unknown) => void = () => {
      throw new Error("Catalog was not requested");
    };
    let cached = false;
    const catalog = new Promise((resolve) => {
      finishCatalog = resolve;
    });
    vi.mocked(customInstance).mockImplementation(async (request) => {
      if (request.url === "/api/lsp/catalog") return (await catalog) as never;
      return {
        ...resolved,
        suggestions: cached
          ? [{ lsp_id: "custom-server", version: "1.0.0", reason: "compatible" }]
          : [],
      } as never;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const first = renderHook(() => useLspResolution({ file_path: "file.custom", project_id: 3 }), {
      wrapper,
    });
    const second = renderHook(
      () => useLspResolution({ file_path: "another.custom", project_id: 3 }),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(first.result.current.data?.suggestions).toEqual([]);
    expect(
      vi
        .mocked(customInstance)
        .mock.calls.filter(([request]) => request.url === "/api/lsp/catalog"),
    ).toHaveLength(1);
    cached = true;
    finishCatalog({ index: null, verified: false, recommended_versions: {} });
    await waitFor(() => expect(first.result.current.data?.suggestions).toHaveLength(1));
    await waitFor(() => expect(second.result.current.data?.suggestions).toHaveLength(1));
  });

  it("does not refetch file resolutions for an unchanged catalog but does for changed policy verdicts", async () => {
    let blocked = false;
    vi.mocked(customInstance).mockImplementation(async (request) => {
      if (request.url === "/api/lsp/catalog")
        return {
          index: null,
          verified: false,
          recommended_versions: {},
          blocked_versions: blocked ? { server: { "1.0.0": "revoked" } } : {},
        } as never;
      return resolved as never;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const first = renderHook(() => useLspResolution({ file_path: "one.custom" }), { wrapper });
    const second = renderHook(() => useLspResolution({ file_path: "two.custom" }), { wrapper });
    await waitFor(() =>
      expect(first.result.current.isSuccess && second.result.current.isSuccess).toBe(true),
    );
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const resolutions = () =>
      vi.mocked(customInstance).mock.calls.filter(([request]) => request.url === "/api/lsp/resolve")
        .length;
    const before = resolutions();
    await act(async () => {
      await client.fetchQuery({ ...lspCatalogQuery, staleTime: 0 });
    });
    expect(resolutions()).toBe(before);
    blocked = true;
    await act(async () => {
      await client.fetchQuery({ ...lspCatalogQuery, staleTime: 0 });
    });
    await waitFor(() => expect(resolutions()).toBe(before + 2));
  });
});
