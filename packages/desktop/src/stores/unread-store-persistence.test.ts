// @vitest-environment happy-dom
/**
 * The unread/failed marks survive a reload of this window: they are written to
 * localStorage on every change and restored when the store module loads.
 * Each test re-imports the store to simulate a reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const KEY = "cadencr:unread-marks:v1";

async function reload() {
  vi.resetModules();
  return import("@/stores/unread-store");
}

beforeEach(() => {
  window.localStorage.clear();
  toastError.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("unread marks persistence", () => {
  it("restores unread and failed marks with their order after a reload", async () => {
    const first = await reload();
    first.useUnreadStore.getState().markFailed(4);
    first.useUnreadStore.getState().markUnread(9);
    first.useUnreadStore.getState().markUnread(4);

    const { useUnreadStore } = await reload();
    const state = useUnreadStore.getState();
    expect(state.byFeature).toEqual({ 9: true, 4: true });
    expect(state.failedByFeature).toEqual({ 4: true });
    expect(state.markedOrder[4]).toBeLessThan(state.markedOrder[9] ?? 0);
  });

  it("forgets a mark once it is read", async () => {
    const first = await reload();
    first.useUnreadStore.getState().markUnread(3);
    first.useUnreadStore.getState().markRead(3);

    const { useUnreadStore } = await reload();
    expect(useUnreadStore.getState()).toMatchObject({
      byFeature: {},
      failedByFeature: {},
      markedOrder: {},
    });
  });

  it("orders a new mark after every restored one", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        marks: [
          [2, "failed"],
          [1, "both"],
        ],
      }),
    );
    const { useUnreadStore } = await reload();
    useUnreadStore.getState().markUnread(5);
    const state = useUnreadStore.getState();
    expect(state.markedOrder).toEqual({ 2: 1, 1: 2, 5: 3 });
    expect(state.byFeature).toEqual({ 1: true, 5: true });
    expect(state.failedByFeature).toEqual({ 1: true, 2: true });
  });

  it("keeps the pull request actions marked done until the conversation is forgotten", async () => {
    const first = await reload();
    first.useUnreadStore.getState().markUnread(6);
    first.useUnreadStore.getState().acknowledge(6, "merge:12:abc");
    first.useUnreadStore.getState().acknowledge(8, "fix_ci:3:def");

    const second = await reload();
    expect(second.useUnreadStore.getState()).toMatchObject({
      byFeature: {},
      prAcks: { 6: "merge:12:abc", 8: "fix_ci:3:def" },
    });
    second.useUnreadStore.getState().forget(8);

    const { useUnreadStore } = await reload();
    expect(useUnreadStore.getState().prAcks).toEqual({ 6: "merge:12:abc" });
  });

  it("restores marks saved before pull request actions could be marked done", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ marks: [[3, "unread"]] }));
    const { useUnreadStore } = await reload();
    expect(useUnreadStore.getState()).toMatchObject({ byFeature: { 3: true }, prAcks: {} });
    expect(toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["the wrong shape", JSON.stringify({ marks: [["7", "unread"]] })],
    ["a non-object", JSON.stringify(42)],
  ])("starts empty and reports it when storage holds %s", async (_label, raw) => {
    vi.useFakeTimers();
    window.localStorage.setItem(KEY, raw);
    const { useUnreadStore } = await reload();
    const { reportUnreadRestoreError } = await import("@/stores/unread-marks-storage");
    expect(useUnreadStore.getState()).toMatchObject({
      byFeature: {},
      failedByFeature: {},
      markedOrder: {},
    });
    expect(console.error).toHaveBeenCalled();
    expect(window.localStorage.getItem(KEY)).toBeNull();

    reportUnreadRestoreError();
    reportUnreadRestoreError();
    vi.runAllTimers();
    expect(toastError).toHaveBeenCalledTimes(1);

    useUnreadStore.getState().markUnread(2);
    expect(useUnreadStore.getState().markedOrder).toEqual({ 2: 1 });
  });

  it("keeps marking in memory and reports once when storage refuses writes", async () => {
    const { useUnreadStore } = await reload();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    useUnreadStore.getState().markUnread(1);
    useUnreadStore.getState().markFailed(2);
    expect(useUnreadStore.getState().byFeature).toEqual({ 1: true });
    expect(useUnreadStore.getState().failedByFeature).toEqual({ 2: true });
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
