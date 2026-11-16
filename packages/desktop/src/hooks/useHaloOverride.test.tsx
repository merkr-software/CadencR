// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { createTestQueryClient } from "@/test-utils";
import {
  DEFAULT_HALO_OVERRIDE,
  parseHaloOverrides,
  THEME_HALO_OVERRIDES_SETTING_KEY,
  type ThemeId,
} from "@/lib/themes";
import { useHaloOverride } from "./useHaloOverride";

interface PendingWrite {
  value: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

const pending: PendingWrite[] = [];
const toastError = vi.fn();
let confirmed: string | null = null;
const clients: QueryClient[] = [];
const queryKey = getGetWorkspaceSettingQueryKey(THEME_HALO_OVERRIDES_SETTING_KEY);

// Only the HTTP boundary is replaced: the setting reader, shared draft and
// serialized writer all run as they do in the app.
vi.mock("@/api/client", () => ({
  customInstance: (config: AxiosRequestConfig) => {
    if (config.method === "GET") return Promise.resolve({ value: confirmed });
    return new Promise((resolve, reject) => {
      const { value } = config.data as { value: string };
      const write: PendingWrite = {
        value,
        settled: false,
        resolve: () => {
          write.settled = true;
          confirmed = value;
          resolve({ value });
        },
        reject: (error) => {
          write.settled = true;
          reject(error);
        },
      };
      pending.push(write);
    });
  },
}));

vi.mock("sonner", () => ({ toast: { error: (message: string) => toastError(message) } }));

function setup(raw: string | null = null) {
  confirmed = raw;
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
  });
  queryClient.setQueryData(queryKey, { value: raw });
  clients.push(queryClient);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const mount = (themeId: ThemeId = "frost-dark") =>
    renderHook(() => useHaloOverride(themeId), { wrapper });
  return { queryClient, mount, wrapper };
}

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function acknowledge(index: number): Promise<void> {
  await act(async () => {
    pending[index]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

function written(index: number) {
  return parseHaloOverrides(pending[index]!.value).value;
}

describe("useHaloOverride with real setting persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pending.length = 0;
    toastError.mockClear();
    confirmed = null;
  });

  afterEach(async () => {
    cleanup();
    await tick();
    // Unmount flushes outstanding debounce timers, including queued writes.
    for (let i = 0; i < pending.length; i++) {
      if (!pending[i]!.settled) await acknowledge(i);
    }
    for (const client of clients.splice(0)) client.clear();
    vi.useRealTimers();
  });

  it("reads the default when the setting is unset", () => {
    const { result } = setup().mount();
    expect(result.current.override).toEqual(DEFAULT_HALO_OVERRIDE);
    expect(result.current.error).toBeNull();
    expect(result.current.isSaving).toBe(false);
  });

  it("reads and normalizes the entry stored for this theme", () => {
    const { result } = setup(
      JSON.stringify({ "frost-dark": { rotation: 45, motion: "lava", speed: 9 } }),
    ).mount();
    expect(result.current.override).toEqual({
      ...DEFAULT_HALO_OVERRIDE,
      rotation: 45,
      motion: "lava",
      speed: 9,
    });
  });

  it("ignores another theme's entry", () => {
    const { result } = setup(JSON.stringify({ "frost-light": { rotation: 45 } })).mount();
    expect(result.current.override).toEqual(DEFAULT_HALO_OVERRIDE);
  });

  it("shares a live preview before debounce or acknowledgement without changing the cache", async () => {
    const { mount, queryClient } = setup();
    const controls = mount();
    const ambient = mount();
    act(() => controls.result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, intensity: 1.5 }));

    expect(controls.result.current.override.intensity).toBe(1.5);
    expect(ambient.result.current.override.intensity).toBe(1.5);
    expect(ambient.result.current.isSaving).toBe(true);
    expect(pending).toHaveLength(0);
    expect(queryClient.getQueryData(queryKey)).toEqual({ value: null });

    await tick(150);
    expect(pending).toHaveLength(1);
    expect(ambient.result.current.override.intensity).toBe(1.5);
    expect(queryClient.getQueryData(queryKey)).toEqual({ value: null });
    await acknowledge(0);
    expect(ambient.result.current.override.intensity).toBe(1.5);
    expect(ambient.result.current.isSaving).toBe(false);
  });

  it("debounces continuous edits and preserves the draft's other fields", async () => {
    const { result } = setup().mount();
    act(() => result.current.setOverride({ ...result.current.override, intensity: 1.5 }));
    await tick(100);
    act(() => result.current.setOverride({ ...result.current.override, rotation: 90 }));
    await tick(100);
    expect(pending).toHaveLength(0);
    await tick(50);
    expect(pending).toHaveLength(1);
    expect(written(0)).toEqual({
      "frost-dark": expect.objectContaining({ rotation: 90, intensity: 1.5 }),
    });
    await acknowledge(0);
  });

  it("keeps another theme's confirmed tuning when saving an edit", async () => {
    const { result } = setup(JSON.stringify({ "frost-light": { rotation: 45 } })).mount();
    act(() => result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, motion: "lava" }));
    await tick(150);
    expect(written(0)).toEqual({
      "frost-light": expect.objectContaining({ rotation: 45 }),
      "frost-dark": expect.objectContaining({ motion: "lava" }),
    });
    await acknowledge(0);
  });

  it("merges edits across drawer unmount and reopen before the previous write is acknowledged", async () => {
    const { mount, queryClient } = setup();
    const dark = mount();
    act(() => dark.result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, intensity: 1.5 }));
    dark.unmount();
    await tick();
    expect(pending).toHaveLength(1);

    const light = mount("frost-light");
    act(() => light.result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, rotation: 45 }));
    await tick(150);
    expect(pending).toHaveLength(1);
    await acknowledge(0);
    expect(pending).toHaveLength(2);
    expect(written(1)).toEqual({
      "frost-dark": expect.objectContaining({ intensity: 1.5 }),
      "frost-light": expect.objectContaining({ rotation: 45 }),
    });
    await acknowledge(1);
    expect(queryClient.getQueryData(queryKey)).toEqual({ value: pending[1]!.value });
  });

  it("flushes the previous theme when the same drawer switches themes", async () => {
    const { wrapper } = setup();
    const drawer = renderHook(({ themeId }: { themeId: ThemeId }) => useHaloOverride(themeId), {
      wrapper,
      initialProps: { themeId: "frost-dark" },
    });
    act(() => drawer.result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, intensity: 1.5 }));
    drawer.rerender({ themeId: "frost-light" });
    await tick();
    expect(pending).toHaveLength(1);
    expect(drawer.result.current.override).toEqual(DEFAULT_HALO_OVERRIDE);
    act(() => drawer.result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, rotation: 45 }));
    await tick(150);
    await acknowledge(0);
    expect(written(1)).toEqual({
      "frost-dark": expect.objectContaining({ intensity: 1.5 }),
      "frost-light": expect.objectContaining({ rotation: 45 }),
    });
    await acknowledge(1);
  });

  it("keeps a newer preview when an older write is acknowledged", async () => {
    const { mount } = setup();
    const controls = mount();
    const ambient = mount();
    act(() => controls.result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, intensity: 1.5 }));
    await tick(150);
    act(() =>
      controls.result.current.setOverride({ ...controls.result.current.override, rotation: 90 }),
    );
    await acknowledge(0);
    expect(ambient.result.current.override).toEqual({
      ...DEFAULT_HALO_OVERRIDE,
      intensity: 1.5,
      rotation: 90,
    });
    expect(ambient.result.current.isSaving).toBe(true);
    await tick(150);
    await acknowledge(1);
    expect(ambient.result.current.isSaving).toBe(false);
  });

  it("resets only its theme against the map confirmed by an earlier queued write", async () => {
    const { mount } = setup(JSON.stringify({ "frost-dark": { intensity: 1.5 } }));
    const dark = mount();
    const light = mount("frost-light");
    act(() => light.result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, rotation: 45 }));
    await tick(150);
    act(() => dark.result.current.reset());
    await tick(150);
    await acknowledge(0);
    expect(written(1)).toEqual({
      "frost-light": expect.objectContaining({ rotation: 45 }),
    });
    await acknowledge(1);
  });

  it("drops a failed preview for both consumers and surfaces the save error", async () => {
    const { mount } = setup(JSON.stringify({ "frost-dark": { intensity: 1.25 } }));
    const controls = mount();
    const ambient = mount();
    act(() =>
      controls.result.current.setOverride({ ...controls.result.current.override, intensity: 1.5 }),
    );
    await tick(150);
    await act(async () => {
      pending[0]!.reject(new Error("service unavailable"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(controls.result.current.override.intensity).toBe(1.25);
    expect(ambient.result.current.override.intensity).toBe(1.25);
    expect(ambient.result.current.isSaving).toBe(false);
    expect(toastError).toHaveBeenCalledWith(
      'Could not save setting "theme_halo_overrides": service unavailable',
    );
  });

  it("does not discard a newer draft when an older write fails", async () => {
    const { result } = setup().mount();
    act(() => result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, intensity: 1.5 }));
    await tick(150);
    act(() => result.current.setOverride({ ...result.current.override, rotation: 90 }));
    await act(async () => {
      pending[0]!.reject(new Error("service unavailable"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.override.rotation).toBe(90);
    await tick(150);
    await acknowledge(1);
    expect(result.current.override.intensity).toBe(1.5);
    expect(result.current.isSaving).toBe(false);
  });

  it("isolates previews between QueryClients", () => {
    const first = setup().mount();
    const second = setup().mount();
    act(() => first.result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, intensity: 1.5 }));
    expect(second.result.current.override).toEqual(DEFAULT_HALO_OVERRIDE);
  });

  it("reports a malformed setting and falls back to the default", () => {
    const { result } = setup("not json").mount();
    expect(result.current.override).toEqual(DEFAULT_HALO_OVERRIDE);
    expect(result.current.error).not.toBeNull();
  });
});
