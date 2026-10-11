import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils";
import { getWorkspaceSettingsQueryKey } from "@/api/settings";
import {
  getManagedThemeCatalog,
  refreshManagedThemeCatalog,
  getManagedThemes,
  installManagedTheme,
  applyManagedTheme,
  removeManagedTheme,
  duplicateManagedTheme,
} from "@/api/generated";
import { DRACULA_THEME } from "@/lib/themes/dracula";
import { useThemeMarketplace } from "./useThemeMarketplace";

vi.mock("@/api/generated", () => ({
  getManagedThemeCatalog: vi.fn(),
  getManagedThemes: vi.fn(),
  refreshManagedThemeCatalog: vi.fn(),
  installManagedTheme: vi.fn(),
  updateManagedTheme: vi.fn(),
  applyManagedTheme: vi.fn(),
  removeManagedTheme: vi.fn(),
  duplicateManagedTheme: vi.fn(),
}));
const index = {
  signed: {
    schema_version: 2,
    generated_at: "2026-10-11T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    packages: [],
  },
  signature: { algorithm: "ed25519" as const, key_id: "qa", value: "signature" },
};
const entry = {
  id: "midnight",
  name: "Midnight",
  version: "1.0.0",
  sha256: "a".repeat(64),
  active: false,
  theme: {
    id: "managed:midnight",
    path: "/isolated/theme.json",
    content: "{}",
    theme: {
      label: "Midnight",
      appearance: "dark" as const,
      cssVars: DRACULA_THEME.cssVars ?? {},
      xterm: DRACULA_THEME.xterm,
    },
    issues: [],
    assets: {},
  },
};
function setup() {
  const client = createTestQueryClient();
  const hook = renderHook(() => useThemeMarketplace(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client };
}
describe("server-confirmed theme operations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getManagedThemes).mockResolvedValue([entry]);
    vi.mocked(getManagedThemeCatalog).mockResolvedValue({
      verified: true,
      index,
      recommended_versions: {},
      error: null,
    });
  });
  it("preserves the facade and actions on unchanged rerenders and publishes state changes", async () => {
    const { result, rerender, client } = setup();
    await waitFor(() => {
      expect(result.current.inventory.isSuccess).toBe(true);
      expect(result.current.catalog.isSuccess).toBe(true);
    });
    const settled = result.current;
    rerender();
    expect(result.current).toBe(settled);
    expect(result.current.mutation.mutate).toBe(settled.mutation.mutate);
    expect(result.current.refresh.mutateAsync).toBe(settled.refresh.mutateAsync);
    expect(result.current.recovery.mutate).toBe(settled.recovery.mutate);

    act(() => client.setQueryData(["marketplace", "managed-themes"], []));
    await waitFor(() => expect(result.current.inventory.data).toEqual([]));
    expect(result.current).not.toBe(settled);
    expect(result.current.catalog).toBe(settled.catalog);
    expect(result.current.mutation).toBe(settled.mutation);
    const updated = result.current;
    rerender();
    expect(result.current).toBe(updated);
  });
  it("passes the exact signed envelope and never changes inventory optimistically", async () => {
    let complete: ((response: typeof entry) => void) | undefined;
    vi.mocked(installManagedTheme).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.inventory.isSuccess).toBe(true));
    act(() =>
      result.current.mutation.mutate({ kind: "install", id: "other", version: "1.0.0", index }),
    );
    await waitFor(() => expect(result.current.mutation.isPending).toBe(true));
    expect(installManagedTheme).toHaveBeenCalledWith({
      theme_id: "other",
      version: "1.0.0",
      index,
    });
    expect(result.current.inventory.data).toHaveLength(1);
    act(() => complete?.(entry));
    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
  });
  it.each(["apply", "remove"] as const)(
    "reconciles settings and inventory after an uncertain %s result",
    async (kind) => {
      vi.mocked(applyManagedTheme).mockRejectedValue(new Error("connection lost"));
      vi.mocked(removeManagedTheme).mockRejectedValue(new Error("connection lost"));
      const { result, client } = setup();
      await waitFor(() => expect(result.current.inventory.isSuccess).toBe(true));
      const spy = vi.spyOn(client, "invalidateQueries");
      act(() =>
        result.current.mutation.mutate(
          kind === "apply"
            ? { kind, id: "midnight" }
            : { kind, id: "midnight", confirmFallback: true },
        ),
      );
      await waitFor(() => expect(result.current.mutation.isError).toBe(true));
      expect(spy).toHaveBeenCalledWith({ queryKey: getWorkspaceSettingsQueryKey() });
      expect(spy).toHaveBeenCalledWith({ queryKey: ["marketplace", "managed-themes"] });
      expect(result.current.notice).toMatch(/not confirmed/i);
      spy.mockClear();
      await act(async () => {
        await result.current.recovery.mutateAsync();
      });
      expect(spy).toHaveBeenCalledWith({ queryKey: getWorkspaceSettingsQueryKey() });
    },
  );
  it("reconciles authored projects after an uncertain duplicate result", async () => {
    vi.mocked(duplicateManagedTheme).mockRejectedValue(new Error("connection lost"));
    const { result, client } = setup();
    await waitFor(() => expect(result.current.inventory.isSuccess).toBe(true));
    const spy = vi.spyOn(client, "invalidateQueries");
    act(() =>
      result.current.mutation.mutate({ kind: "duplicate", id: "midnight", label: "Editable" }),
    );
    await waitFor(() => expect(result.current.mutation.isError).toBe(true));
    expect(spy.mock.calls.some(([options]) => typeof options?.predicate === "function")).toBe(true);
    expect(result.current.notice).toMatch(/not confirmed/i);
  });
  it("revalidates installed themes after a confirmed catalog and policy refresh", async () => {
    vi.mocked(refreshManagedThemeCatalog).mockResolvedValue({
      verified: true,
      index,
      recommended_versions: {},
      error: null,
    });
    const { result, client } = setup();
    await waitFor(() => expect(result.current.inventory.isSuccess).toBe(true));
    let completeInventory:
      | ((entries: Awaited<ReturnType<typeof getManagedThemes>>) => void)
      | undefined;
    vi.mocked(getManagedThemes).mockImplementation(
      () =>
        new Promise((resolve) => {
          completeInventory = resolve;
        }),
    );
    const spy = vi.spyOn(client, "invalidateQueries");
    act(() => result.current.refresh.mutate());
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["marketplace", "managed-themes"] }),
    );
    expect(result.current.refresh.isPending).toBe(true);
    expect(result.current.inventory.data?.[0].theme).not.toBeNull();
    await act(async () => {
      completeInventory?.([
        {
          ...entry,
          theme: null,
          error: "Installed revision revoked",
          error_code: "MANAGED_THEME_REVOKED",
        },
      ]);
    });
    await waitFor(() => expect(result.current.refresh.isSuccess).toBe(true));
    expect(result.current.inventory.data?.[0].error_code).toBe("MANAGED_THEME_REVOKED");
    expect(result.current.inventory.data?.[0].theme).toBeNull();
  });
  it("does not fall back to the previous verified catalog after a signature rejection", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.catalog.data?.verified).toBe(true));
    vi.mocked(refreshManagedThemeCatalog).mockResolvedValue({
      verified: false,
      index: null,
      recommended_versions: {},
      error: "Invalid catalog signature",
    });
    await act(() => result.current.refresh.mutateAsync());
    await waitFor(() => expect(result.current.catalog.data?.verified).toBe(false));
    expect(result.current.catalog.data?.index).toBeNull();
    expect(result.current.catalog.data?.error).toBe("Invalid catalog signature");
    expect(installManagedTheme).not.toHaveBeenCalled();
  });
});
