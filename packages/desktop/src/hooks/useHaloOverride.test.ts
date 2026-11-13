// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHaloOverride } from "./useHaloOverride";
import { DEFAULT_HALO_OVERRIDE, THEME_HALO_OVERRIDES_SETTING_KEY } from "@/lib/themes";

const setDraft = vi.fn<(value: string) => void>();
const draftHook = vi.fn<(key: string, debounceMs: number) => void>();
let confirmed: string | null = null;
let draft: string | null = null;
let isLoading = false;
let isSaving = false;

vi.mock("@/hooks/useSettingDraft", () => ({
  useSettingDraft: (key: string, debounceMs: number) => {
    draftHook(key, debounceMs);
    return { value: confirmed, draft, setDraft, isLoading, isFetched: !isLoading, isSaving };
  },
}));

/** The map the last `setOverride` handed to the debounced write. */
function written(): Record<string, unknown> {
  const value = setDraft.mock.calls.at(-1)?.[0];
  if (value === undefined) throw new Error("nothing was written");
  return JSON.parse(value) as Record<string, unknown>;
}

describe("useHaloOverride", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmed = null;
    draft = null;
    isLoading = false;
    isSaving = false;
  });

  it("reads the default when the setting is unset", () => {
    const { result } = renderHook(() => useHaloOverride("frost-dark"));

    expect(result.current.override).toEqual(DEFAULT_HALO_OVERRIDE);
    expect(result.current.error).toBeNull();
  });

  it("reads the entry stored for this theme", () => {
    confirmed = JSON.stringify({ "frost-dark": { rotation: 45, motion: "lava", speed: 9 } });
    const { result } = renderHook(() => useHaloOverride("frost-dark"));

    expect(result.current.override.rotation).toBe(45);
    expect(result.current.override.motion).toBe("lava");
    expect(result.current.override.speed).toBe(9);
    // Fields the entry omits fall back on their own.
    expect(result.current.override.intensity).toBe(DEFAULT_HALO_OVERRIDE.intensity);
  });

  it("ignores another theme's entry", () => {
    confirmed = JSON.stringify({ "frost-light": { rotation: 45 } });
    const { result } = renderHook(() => useHaloOverride("frost-dark"));

    expect(result.current.override).toEqual(DEFAULT_HALO_OVERRIDE);
  });

  it("writes the whole map, keeping the other themes", () => {
    confirmed = JSON.stringify({ "frost-light": { rotation: 45 } });
    const { result } = renderHook(() => useHaloOverride("frost-dark"));

    act(() => result.current.setOverride({ ...DEFAULT_HALO_OVERRIDE, motion: "lava" }));

    expect(written()).toEqual({
      "frost-light": expect.objectContaining({ rotation: 45 }),
      "frost-dark": expect.objectContaining({ motion: "lava" }),
    });
  });

  it("builds the next write from the draft, so a drag is not reverted", () => {
    // The backend still holds nothing while the drag is in flight.
    confirmed = null;
    draft = JSON.stringify({ "frost-dark": { rotation: 45, intensity: 1.5 } });
    const { result } = renderHook(() => useHaloOverride("frost-dark"));

    act(() => result.current.setOverride({ ...result.current.override, rotation: 90 }));

    expect(written()).toEqual({
      "frost-dark": expect.objectContaining({ rotation: 90, intensity: 1.5 }),
    });
  });

  it("drops the theme's entry when reset", () => {
    confirmed = JSON.stringify({
      "frost-dark": { rotation: 45, motion: "lava" },
      "frost-light": { rotation: 45 },
    });
    const { result } = renderHook(() => useHaloOverride("frost-dark"));

    act(() => result.current.reset());

    expect(written()).toEqual({
      "frost-light": expect.objectContaining({ rotation: 45 }),
    });
  });

  it("reports a malformed setting and falls back to the default", () => {
    confirmed = "not json";
    const { result } = renderHook(() => useHaloOverride("frost-dark"));

    expect(result.current.override).toEqual(DEFAULT_HALO_OVERRIDE);
    expect(result.current.error).not.toBeNull();
  });

  it("debounces the write and reports the setting's own state", () => {
    isLoading = true;
    isSaving = true;
    const { result } = renderHook(() => useHaloOverride("frost-dark"));

    expect(draftHook).toHaveBeenCalledWith(THEME_HALO_OVERRIDES_SETTING_KEY, 150);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isSaving).toBe(true);
  });
});
