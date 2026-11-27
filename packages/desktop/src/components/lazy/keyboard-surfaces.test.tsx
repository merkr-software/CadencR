import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test-utils";
import {
  KEYBOARD_SURFACE_PREFETCH_TIMEOUT_MS,
  useKeyboardSurfacePrefetch,
} from "./keyboard-surfaces";

const mocks = vi.hoisted(() => ({
  touch: false,
  palette: vi.fn(() => Promise.resolve()),
  files: vi.fn(() => Promise.resolve()),
  search: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/useIsTouchDevice", () => ({ useIsTouchDevice: () => mocks.touch }));
vi.mock("@/components/CommandPalette", () => ({ prefetchCommandPalette: mocks.palette }));
vi.mock("@/components/editor/EditorFuzzyShortcut", () => ({ prefetchFileSearch: mocks.files }));
vi.mock("@/components/FeatureContentSearchShortcut", () => ({
  prefetchContentSearch: mocks.search,
}));

const prefetched = (): number =>
  mocks.palette.mock.calls.length + mocks.files.mock.calls.length + mocks.search.mock.calls.length;

describe("useKeyboardSurfacePrefetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("fetches ⌘K, ⌘P and ⌘⇧F after mount, once idle, under a mouse in any layout", () => {
    mocks.touch = false;
    renderHook(() => useKeyboardSurfacePrefetch());
    // Not before the first paint's work is done.
    expect(prefetched()).toBe(0);
    act(() => vi.advanceTimersByTime(KEYBOARD_SURFACE_PREFETCH_TIMEOUT_MS));
    expect(mocks.palette).toHaveBeenCalledTimes(1);
    expect(mocks.files).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledTimes(1);
  });

  it("leaves them to first use under a finger", () => {
    mocks.touch = true;
    renderHook(() => useKeyboardSurfacePrefetch());
    act(() => vi.advanceTimersByTime(KEYBOARD_SURFACE_PREFETCH_TIMEOUT_MS * 2));
    expect(prefetched()).toBe(0);
  });
});
