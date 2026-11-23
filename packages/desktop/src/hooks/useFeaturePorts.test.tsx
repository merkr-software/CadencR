import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { getListFeaturePortsQueryKey, type FeaturePorts } from "@/api/generated";
import { useConnectionStatusStore } from "@/stores/connection-status-store";
import { server } from "@/test/msw-server";
import { useFeaturePorts } from "./useFeaturePorts";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }));

const snapshot: FeaturePorts[] = [
  { feature_id: 7, ports: [{ port: 3000, pid: 42, process: "node", source: "terminal" }] },
  { feature_id: 8, ports: [{ port: 4000, pid: 43, process: "node", source: "agent" }] },
];
const queryKey = [...getListFeaturePortsQueryKey(), null];
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 30_000 } },
  });
  useConnectionStatusStore.setState({ status: "connected", lastConnectedAt: null, sources: {} });
  server.use(http.get("*/api/features/ports", () => HttpResponse.json(snapshot)));
});

afterEach(() => {
  client.clear();
  focusManager.setFocused(undefined);
});

describe("useFeaturePorts live snapshots", () => {
  it("waits for a new scan instead of displaying a stale cached snapshot on mount", async () => {
    client.setQueryData(queryKey, snapshot, { updatedAt: Date.now() - 5_000 });
    server.use(http.get("*/api/features/ports", () => HttpResponse.json([])));

    const { result } = renderHook(useFeaturePorts, { wrapper });

    expect(result.current.size).toBe(0);
    await waitFor(() => expect(client.getQueryData(queryKey)).toEqual([]));
    expect(result.current.size).toBe(0);
  });

  it("shares a fresh snapshot across newly mounted callers without refetching", async () => {
    const requests = vi.fn();
    server.use(
      http.get("*/api/features/ports", () => {
        requests();
        return HttpResponse.json(snapshot);
      }),
    );

    const first = renderHook(useFeaturePorts, { wrapper });
    await waitFor(() => expect(first.result.current.size).toBe(2));

    const second = renderHook(useFeaturePorts, { wrapper });
    expect(second.result.current.size).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(requests).toHaveBeenCalledOnce();
  });

  it("removes terminal and agent ports when the next scan no longer finds them", async () => {
    const { result } = renderHook(useFeaturePorts, { wrapper });
    await waitFor(() => expect(result.current.size).toBe(2));
    server.use(http.get("*/api/features/ports", () => HttpResponse.json([])));

    await act(() => client.refetchQueries({ queryKey }));

    await waitFor(() => expect(result.current.size).toBe(0));
  });

  it("does not present the last successful scan as live after a scan fails", async () => {
    const { result } = renderHook(useFeaturePorts, { wrapper });
    await waitFor(() => expect(result.current.size).toBe(2));
    server.use(
      http.get("*/api/features/ports", () =>
        HttpResponse.json({ error: "scan failed" }, { status: 500 }),
      ),
    );

    await act(() => client.refetchQueries({ queryKey }));

    await waitFor(() => expect(result.current.size).toBe(0));
    expect(client.getQueryData(queryKey)).toEqual(snapshot);
    expect(toast.error).toHaveBeenCalled();
    server.use(http.get("*/api/features/ports", () => HttpResponse.json(snapshot)));
    await act(() => client.refetchQueries({ queryKey }));
    await waitFor(() => expect(result.current.size).toBe(2));
  });

  it("hides ports on disconnect and confirms them again after a service restart", async () => {
    const { result } = renderHook(useFeaturePorts, { wrapper });
    await waitFor(() => expect(result.current.size).toBe(2));
    act(() => useConnectionStatusStore.getState().reportSource("health", "disconnected"));
    expect(result.current.size).toBe(0);
    server.use(http.get("*/api/features/ports", () => HttpResponse.json([])));

    act(() => useConnectionStatusStore.getState().reportSource("health", "connected"));

    expect(result.current.size).toBe(0);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(result.current.size).toBe(0);
  });

  it("suppresses focus refetches while fresh and rescans on focus once stale", async () => {
    const requests = vi.fn();
    let payload: FeaturePorts[] = snapshot;
    server.use(
      http.get("*/api/features/ports", () => {
        requests();
        return HttpResponse.json(payload);
      }),
    );

    const { result } = renderHook(useFeaturePorts, { wrapper });
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(requests).toHaveBeenCalledOnce();

    // Window focus while data is still fresh within staleTime suppresses a redundant scan.
    payload = [];
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(requests).toHaveBeenCalledOnce();
    expect(result.current.size).toBe(2);

    // Once stale, focusing the window immediately rescans.
    client.setQueryData(queryKey, snapshot, { updatedAt: Date.now() - 5_000 });
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));

    await waitFor(() => expect(result.current.size).toBe(0));
    expect(requests).toHaveBeenCalledTimes(2);
  });

  it("cannot revive a pre-disconnect scan that completes after reconnect", async () => {
    let releaseOldScan!: () => void;
    const oldScan = new Promise<void>((resolve) => {
      releaseOldScan = resolve;
    });
    let releaseNewScan!: () => void;
    const newScan = new Promise<void>((resolve) => {
      releaseNewScan = resolve;
    });
    const requests = vi.fn();
    server.use(
      http.get("*/api/features/ports", async () => {
        requests();
        if (requests.mock.calls.length === 1) {
          await oldScan;
          return HttpResponse.json(snapshot);
        }
        await newScan;
        return HttpResponse.json(snapshot.slice(1));
      }),
    );
    const { result } = renderHook(useFeaturePorts, { wrapper });
    await waitFor(() => expect(requests).toHaveBeenCalledOnce());

    act(() => useConnectionStatusStore.getState().reportSource("health", "disconnected"));
    act(() => useConnectionStatusStore.getState().reportSource("health", "connected"));
    await act(async () => releaseOldScan());

    await waitFor(() => expect(requests).toHaveBeenCalledTimes(2));
    expect(result.current.size).toBe(0);
    await act(async () => releaseNewScan());
    await waitFor(() => expect([...result.current.keys()]).toEqual([8]));
  });

  it("keeps badges shown after mount once the shared snapshot turns stale", async () => {
    // Fetched 3.2 s ago by another section: fresh (4 s) when this one mounts.
    client.setQueryData(queryKey, snapshot, { updatedAt: Date.now() - 3_200 });
    const requests = vi.fn();
    server.use(
      http.get("*/api/features/ports", () => {
        requests();
        return HttpResponse.json(snapshot);
      }),
    );

    const { result } = renderHook(useFeaturePorts, { wrapper });
    expect(result.current.size).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(result.current.size).toBe(2);
    expect(requests).not.toHaveBeenCalled();
  });

  it("retries a transient failure once without surfacing it", async () => {
    client = new QueryClient({
      defaultOptions: { queries: { retryDelay: 10, gcTime: 0, staleTime: 30_000 } },
    });
    const requests = vi.fn();
    server.use(
      http.get("*/api/features/ports", () => {
        requests();
        if (requests.mock.calls.length === 1) {
          return HttpResponse.json(
            { error: "The database is busy", code: "DATABASE_BUSY" },
            { status: 503 },
          );
        }
        return HttpResponse.json(snapshot);
      }),
    );

    const { result } = renderHook(useFeaturePorts, { wrapper });

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(requests).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not retry a scan the backend is backing off from", async () => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: 2, retryDelay: 10, gcTime: 0, staleTime: 30_000 } },
    });
    const requests = vi.fn();
    server.use(
      http.get("*/api/features/ports", () => {
        requests();
        return HttpResponse.json(
          { error: "lsof timed out", code: "PORT_SCAN_TIMEOUT" },
          { status: 503 },
        );
      }),
    );

    renderHook(useFeaturePorts, { wrapper });

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(requests).toHaveBeenCalledOnce();
  });
});
