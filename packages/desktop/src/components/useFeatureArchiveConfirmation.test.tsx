import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGetFeatureArchivePreviewQueryKey,
  getIsFeatureEmptyQueryKey,
  type Feature,
  type FeatureWorktreeInfo,
} from "@/api/generated";
import { useFeatureArchiveConfirmation } from "./useFeatureArchiveConfirmation";

const customInstance = vi.hoisted(() => vi.fn());

vi.mock("@/api/client", () => ({ customInstance }));
vi.mock("sonner", () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const feature: Feature = {
  id: 1,
  project_id: 1,
  title: "Parent",
  type: "ws-session",
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  is_pinned: false,
};

describe("useFeatureArchiveConfirmation", () => {
  beforeEach(() => {
    customInstance.mockReset();
    customInstance.mockImplementation(({ url }: { url: string }) => {
      if (url.endsWith("/empty")) return Promise.resolve({ empty: false });
      return Promise.resolve({ parent_ids: [], descendant_ids: [2], has_relations: true });
    });
  });

  it("latches the decision while the real preview query refetches", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(
      () => useFeatureArchiveConfirmation(1, [feature], new Map<number, FeatureWorktreeInfo>()),
      { wrapper },
    );
    await waitFor(() => expect(result.current.action).toBe("archive"));

    let resolveRefetch: ((value: unknown) => void) | undefined;
    customInstance.mockImplementation(({ url }: { url: string }) => {
      if (url.endsWith("/empty")) return Promise.resolve({ empty: true });
      return new Promise((resolve) => {
        resolveRefetch = resolve;
      });
    });
    void client.invalidateQueries({ queryKey: getGetFeatureArchivePreviewQueryKey(1) });
    await waitFor(() => expect(resolveRefetch).toBeDefined());

    expect(result.current.action).toBe("archive");
    resolveRefetch?.({ parent_ids: [], descendant_ids: [], has_relations: false });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(result.current.action).toBe("archive");
    client.clear();
  });

  it("waits for fresh checks instead of latching delete from stale cached data", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    client.setQueryData(getIsFeatureEmptyQueryKey(1), { empty: true });
    client.setQueryData(getGetFeatureArchivePreviewQueryKey(1), {
      parent_ids: [],
      descendant_ids: [],
      has_relations: false,
    });
    let resolveEmpty: ((value: unknown) => void) | undefined;
    let resolvePreview: ((value: unknown) => void) | undefined;
    customInstance.mockImplementation(({ url }: { url: string }) => {
      return new Promise((resolve) => {
        if (url.endsWith("/empty")) resolveEmpty = resolve;
        else resolvePreview = resolve;
      });
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    let confirmFeatureId: number | null = null;
    const { result, rerender } = renderHook(
      () =>
        useFeatureArchiveConfirmation(
          confirmFeatureId,
          [feature],
          new Map<number, FeatureWorktreeInfo>(),
        ),
      { wrapper },
    );
    confirmFeatureId = 1;
    rerender();
    await waitFor(() => {
      expect(resolveEmpty).toBeDefined();
      expect(resolvePreview).toBeDefined();
    });
    expect(result.current.action).toBeNull();

    resolveEmpty?.({ empty: true });
    resolvePreview?.({ parent_ids: [9], descendant_ids: [], has_relations: true });
    await waitFor(() => expect(result.current.action).toBe("archive"));
    client.clear();
  });

  it("keeps the latched action through empty-check invalidation and status changes", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    let currentFeature = feature;
    const { result, rerender } = renderHook(
      () =>
        useFeatureArchiveConfirmation(1, [currentFeature], new Map<number, FeatureWorktreeInfo>()),
      { wrapper },
    );
    await waitFor(() => expect(result.current.action).toBe("archive"));

    let resolveEmpty: ((value: unknown) => void) | undefined;
    customInstance.mockImplementation(({ url }: { url: string }) => {
      if (!url.endsWith("/empty")) {
        return Promise.resolve({ parent_ids: [], descendant_ids: [], has_relations: false });
      }
      return new Promise((resolve) => {
        resolveEmpty = resolve;
      });
    });
    void client.invalidateQueries({ queryKey: getIsFeatureEmptyQueryKey(1) });
    await waitFor(() => expect(resolveEmpty).toBeDefined());
    expect(result.current.action).toBe("archive");

    currentFeature = { ...feature, status: "archived" };
    rerender();
    expect(result.current.action).toBe("archive");
    resolveEmpty?.({ empty: true });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(result.current.action).toBe("archive");
    client.clear();
  });

  it("does not retry preflight empty or archive-preview checks on error", async () => {
    customInstance.mockRejectedValue(new Error("backend unavailable"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 3, retryDelay: 1 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    const { result } = renderHook(
      () => useFeatureArchiveConfirmation(1, [feature], new Map<number, FeatureWorktreeInfo>()),
      { wrapper },
    );

    await waitFor(() => expect(result.current.action).toBe("archive"));
    // Exactly 1 attempt for /empty and 1 attempt for /archive-preview (no retries).
    expect(customInstance).toHaveBeenCalledTimes(2);
    client.clear();
  });
});
