// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "cadencr:remote-prevent-sleep";

// Re-import per test so the module-level cache starts fresh.
async function load(): Promise<typeof import("./sleep-prevention")> {
  vi.resetModules();
  return import("./sleep-prevention");
}

describe("remote sleep-prevention preference", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("defaults to false when unset", async () => {
    const { readRemotePreventSleep } = await load();
    expect(readRemotePreventSleep()).toBe(false);
  });

  it("persists the value to localStorage and reads it back", async () => {
    const { readRemotePreventSleep, setRemotePreventSleep } = await load();
    setRemotePreventSleep(true);
    expect(localStorage.getItem(KEY)).toBe("true");
    expect(readRemotePreventSleep()).toBe(true);

    setRemotePreventSleep(false);
    expect(localStorage.getItem(KEY)).toBe("false");
    expect(readRemotePreventSleep()).toBe(false);
  });

  it("hydrates the cached read from a pre-existing stored value", async () => {
    localStorage.setItem(KEY, "true");
    const { readRemotePreventSleep } = await load();
    expect(readRemotePreventSleep()).toBe(true);
  });

  it("notifies subscribers on same-tab writes and reflects the new value", async () => {
    const { readRemotePreventSleep, setRemotePreventSleep } = await load();
    let notified = 0;
    // `subscribe` isn't exported; the dispatched event is the public contract.
    window.addEventListener("cadencr:remote-prevent-sleep-changed", () => {
      notified += 1;
    });
    setRemotePreventSleep(true);
    expect(notified).toBe(1);
    expect(readRemotePreventSleep()).toBe(true);
  });
});
