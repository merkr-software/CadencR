import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createTestQueryClient } from "@/test-utils";
import { catalog, inventory, enabled, install, update } from "@/api/generated";
import { useMarketplace } from "./useMarketplace";

vi.mock("@/api/generated", () => ({
  catalog: vi.fn(),
  inventory: vi.fn(),
  refreshCatalog: vi.fn(),
  enabled: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  rollback: vi.fn(),
}));
const entry = {
  id: "example",
  version: "1.0.0",
  digest: "digest",
  active_now: false,
  active_after_restart: true,
  enabled_after_restart: true,
  restart_required: true,
  history: [],
  quarantine: [],
};
const inventoryResult = {
  providers: [entry],
  root: "/test",
  trust: { status: "configured" as const },
  blocklist: { cache_status: "missing" as const, source_configured: false },
  process_policy: {
    child_count_limit: { status: "applied" as const },
    cpu_limit: { status: "applied" as const },
    memory_limit: { status: "applied" as const },
    descendant_termination: { status: "applied" as const },
    default_one_shot_timeout_seconds: 60,
  },
};
function setup() {
  const client = createTestQueryClient();
  return renderHook(() => useMarketplace(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
describe("useMarketplace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(catalog).mockResolvedValue({
      source_configured: false,
      cache_status: "missing",
      refreshed: false,
      used_cached_verified_catalog: false,
    });
    vi.mocked(inventory).mockResolvedValue(inventoryResult);
  });
  it("does not change installed state before backend confirmation", async () => {
    let resolve: ((value: typeof entry) => void) | undefined;
    vi.mocked(enabled).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.inventoryQuery.isSuccess).toBe(true));
    act(() => result.current.mutation.mutate({ kind: "enabled", id: "example", enabled: false }));
    await waitFor(() => expect(result.current.mutation.isPending).toBe(true));
    expect(result.current.inventoryQuery.data?.providers[0].enabled_after_restart).toBe(true);
    vi.mocked(inventory).mockResolvedValue({
      ...inventoryResult,
      providers: [{ ...entry, enabled_after_restart: false }],
    });
    act(() => resolve?.({ ...entry, enabled_after_restart: false }));
    await waitFor(() =>
      expect(result.current.inventoryQuery.data?.providers[0].enabled_after_restart).toBe(false),
    );
    expect(result.current.notice?.text).toContain("Restart Cadencr");
  });
  it("names only the provider and version: the service installs from its verified catalog", async () => {
    vi.mocked(install).mockResolvedValue(entry);
    vi.mocked(update).mockResolvedValue(entry);
    const { result } = setup();
    await act(() =>
      result.current.mutation.mutateAsync({ kind: "install", id: "example", version: "1.0.0" }),
    );
    expect(install).toHaveBeenCalledWith({ provider_id: "example", version: "1.0.0" });
    await act(() =>
      result.current.mutation.mutateAsync({ kind: "update", id: "example", version: "2.0.0" }),
    );
    expect(update).toHaveBeenCalledWith("example", { version: "2.0.0" });
  });
  it("surfaces backend rejection and rechecks inventory", async () => {
    vi.mocked(enabled).mockRejectedValue(new Error("provider blocked"));
    const { result } = setup();
    await waitFor(() => expect(result.current.inventoryQuery.isSuccess).toBe(true));
    act(() => result.current.mutation.mutate({ kind: "enabled", id: "example", enabled: false }));
    await waitFor(() => expect(result.current.mutation.error?.message).toBe("provider blocked"));
    expect(result.current.inventoryQuery.data?.providers[0].enabled_after_restart).toBe(true);
    expect(inventory).toHaveBeenCalledTimes(2);
  });
});
