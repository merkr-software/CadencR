import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_RENEW_MS, type PresenceDeps } from "./broker-presence";
import { SurfacePresenceLeases } from "./surface-presence";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("surface leases", () => {
  it("shares a logical lease across owners and keeps editor/tab leases independent", async () => {
    let id = 0;
    const deps: PresenceDeps = {
      renew: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      report: vi.fn(),
      newLeaseId: () => `lease-${++id}`,
    };
    const leases = new SurfacePresenceLeases(deps);
    const wanted = { instanceId: "7:editor:demo", featureId: 7, pluginId: "demo", name: "Editor" };
    const first = leases.acquire(wanted);
    const second = leases.acquire(wanted);
    const tab = leases.acquire({ ...wanted, instanceId: "7:plugin:demo" });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.renew).toHaveBeenCalledTimes(2);
    first();
    first();
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS);
    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.renew).toHaveBeenCalledTimes(4);
    tab();
    expect(deps.release).toHaveBeenCalledWith("demo", "lease-2");
    second();
    expect(deps.release).toHaveBeenCalledWith("demo", "lease-1");
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS);
    expect(deps.renew).toHaveBeenCalledTimes(4);
  });

  it("rejects identity reuse and never renews a StrictMode throwaway lease", async () => {
    const deps: PresenceDeps = {
      renew: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      report: vi.fn(),
      newLeaseId: () => "one",
    };
    const leases = new SurfacePresenceLeases(deps);
    const wanted = { instanceId: "7:editor:demo", featureId: 7, pluginId: "demo", name: "Editor" };
    const release = leases.acquire(wanted);
    expect(() => leases.acquire({ ...wanted, featureId: 8 })).toThrow(/identity/);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.renew).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });
});
