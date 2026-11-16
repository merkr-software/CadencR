import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicationOperationsStatus } from "./PublicationOperationsStatus";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/api/client", () => ({ customInstance: request }));
const id = "a".repeat(64);
function setup(operationId?: string, publicationPending = false): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PublicationOperationsStatus
        projectId={1}
        operationId={operationId}
        publicationPending={publicationPending}
      />
    </QueryClientProvider>,
  );
}
function record(status: "succeeded" | "unknown" | "running") {
  return {
    operation_id: id,
    project_id: 1,
    kind: "release",
    status,
    attempt: 1,
    updated_at: "2026-10-11T08:00:00Z",
    error: status === "unknown" ? "Reconcile this confirmed operation." : null,
    error_code: status === "unknown" ? "PUBLICATION_OPERATION_UNKNOWN" : null,
    result:
      status === "succeeded"
        ? {
            kind: "release",
            value: { release_url: "https://github.com/acme/plugin/releases/tag/v1" },
          }
        : null,
  };
}
beforeEach(() => {
  request.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("durable publication status", () => {
  it("shows recorded unknown outcomes without calling them failed", async () => {
    request.mockResolvedValue({ operations: [record("unknown")], next_cursor: null });
    setup();
    expect(await screen.findByText(/release · unknown · attempt 1/)).toBeInTheDocument();
    expect(screen.getByText(id)).toBeInTheDocument();
    expect(screen.getByText(/Reconcile this confirmed operation/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("does not infer that a missing journal record means publication never started", async () => {
    request.mockImplementation(({ url }: { url: string }) =>
      url.endsWith(id)
        ? Promise.reject(
            Object.assign(new Error("Not found"), {
              isAxiosError: true,
              response: { status: 404 },
            }),
          )
        : Promise.resolve({ operations: [], next_cursor: null }),
    );
    setup(id);
    await waitFor(() =>
      expect(screen.getByText(/missing record does not prove/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Publication has not started/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("surfaces inaccessible journal errors rather than inventing an outcome", async () => {
    request.mockRejectedValue(new Error("Journal unavailable"));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Journal unavailable");
    expect(screen.queryByText(/release · succeeded/)).not.toBeInTheDocument();
  });
  it("rejects an unsafe result URL at the API boundary", async () => {
    const value = record("succeeded");
    if (value.result) value.result.value.release_url = "https://untrusted.example/release";
    request.mockResolvedValue({ operations: [value], next_cursor: null });
    setup();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Result:/)).not.toBeInTheDocument();
  });
  it("does not poll terminal history or a terminal focused operation", async () => {
    vi.useFakeTimers();
    request.mockImplementation(({ url }: { url: string }) =>
      Promise.resolve(
        url.endsWith(id)
          ? record("succeeded")
          : { operations: [record("succeeded")], next_cursor: null },
      ),
    );
    setup(id);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("polls active records and stops when the server confirms completion", async () => {
    vi.useFakeTimers();
    let status: "running" | "succeeded" = "running";
    request.mockImplementation(({ url }: { url: string }) =>
      Promise.resolve(
        url.endsWith(id) ? record(status) : { operations: [record(status)], next_cursor: null },
      ),
    );
    setup(id);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(request).toHaveBeenCalledTimes(2);
    status = "succeeded";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(request).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("does not continually retry an unstarted preview ID", async () => {
    vi.useFakeTimers();
    request.mockImplementation(({ url }: { url: string }) =>
      url.endsWith(id)
        ? Promise.reject({ response: { status: 404 } })
        : Promise.resolve({ operations: [], next_cursor: null }),
    );
    setup(id);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("polls while a publication mutation is pending even before its journal record exists", async () => {
    vi.useFakeTimers();
    request.mockImplementation(({ url }: { url: string }) =>
      url.endsWith(id)
        ? Promise.reject({ response: { status: 404 } })
        : Promise.resolve({ operations: [], next_cursor: null }),
    );
    setup(id, true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(request).toHaveBeenCalledTimes(4);
  });
});
