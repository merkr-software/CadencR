import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRESENCE_RENEW_MS,
  PRESENCE_RERELEASE_MS,
  PresenceLease,
  type PresenceDeps,
} from "./broker-presence";
import { serviceError } from "@/components/settings/custom-tabs/custom-tabs-fixtures";
import { PLUGIN_TAB_ERROR } from "./error-codes";

function deps(overrides: Partial<PresenceDeps> = {}): PresenceDeps {
  return {
    renew: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    report: vi.fn(),
    newLeaseId: () => "lease-1",
    ...overrides,
  };
}

describe("PresenceLease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews every minute while open, idle or not, and releases on close", async () => {
    const presence = deps();
    const lease = new PresenceLease("ports", 7, "Ports", presence);
    await vi.advanceTimersByTimeAsync(0);
    expect(presence.renew).toHaveBeenCalledWith("ports", "lease-1", 7, expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS * 30);
    expect(presence.renew).toHaveBeenCalledTimes(31);
    lease.dispose();
    lease.dispose();
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS * 3);
    expect(presence.renew).toHaveBeenCalledTimes(31);
    expect(presence.release).toHaveBeenCalledTimes(1);
    expect(presence.release).toHaveBeenCalledWith("ports", "lease-1");
  });

  it("releases at once on close, aborting a renewal that hangs", async () => {
    let signal: AbortSignal | undefined;
    const presence = deps({
      renew: vi.fn((_plugin: string, _lease: string, _feature: number, abort: AbortSignal) => {
        signal = abort;
        return new Promise<void>(() => undefined);
      }),
    });
    const lease = new PresenceLease("ports", 7, "Ports", presence);
    await vi.advanceTimersByTimeAsync(0);
    lease.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    expect(presence.release).toHaveBeenCalledTimes(1);
    expect(presence.report).not.toHaveBeenCalled();
    // The aborted renewal might still have reached the service: release once more.
    await vi.advanceTimersByTimeAsync(PRESENCE_RERELEASE_MS);
    expect(presence.release).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS * 5);
    expect(presence.release).toHaveBeenCalledTimes(2);
    expect(presence.renew).toHaveBeenCalledTimes(1);
  });

  it("releases again when a renewal lands after the close", async () => {
    let finish: () => void = () => undefined;
    const order: string[] = [];
    const presence = deps({
      // A transport that ignores the abort.
      renew: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = () => {
              order.push("renewed");
              resolve();
            };
          }),
      ),
      release: vi.fn(async () => {
        order.push("released");
      }),
    });
    const lease = new PresenceLease("ports", 7, "Ports", presence);
    await vi.advanceTimersByTimeAsync(0);
    lease.dispose();
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["released", "renewed", "released"]);
  });

  it("takes no lease for an instance torn down at once, as StrictMode's remount does", async () => {
    let next = 0;
    const presence = deps({ newLeaseId: () => `lease-${++next}` });
    new PresenceLease("ports", 7, "Ports", presence).dispose();
    const open = new PresenceLease("ports", 7, "Ports", presence);
    await vi.advanceTimersByTimeAsync(PRESENCE_RERELEASE_MS * 2);
    expect(presence.renew).toHaveBeenCalledTimes(1);
    expect(presence.renew).toHaveBeenCalledWith("ports", "lease-2", 7, expect.any(AbortSignal));
    expect(presence.release).not.toHaveBeenCalled();
    open.dispose();
    await vi.advanceTimersByTimeAsync(PRESENCE_RERELEASE_MS * 2);
    expect(presence.release).toHaveBeenCalledTimes(1);
    expect(presence.release).toHaveBeenCalledWith("ports", "lease-2");
  });

  it("doesn't release twice when no renewal was in flight", async () => {
    const presence = deps();
    const lease = new PresenceLease("ports", 7, "Ports", presence);
    await vi.advanceTimersByTimeAsync(0);
    lease.dispose();
    await vi.advanceTimersByTimeAsync(PRESENCE_RERELEASE_MS * 2);
    expect(presence.release).toHaveBeenCalledTimes(1);
  });

  it("gives up on a renewal stuck for a minute, and reports it once", async () => {
    const signals: AbortSignal[] = [];
    const presence = deps({
      renew: vi.fn((_plugin: string, _lease: string, _feature: number, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("canceled"))),
        );
      }),
    });
    const lease = new PresenceLease("ports", 7, "Ports", presence);
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS * 2);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
    expect(presence.report).toHaveBeenCalledTimes(1);
    expect(presence.report).toHaveBeenCalledWith(
      expect.stringContaining("could not be told the tab is open"),
      expect.objectContaining({ message: expect.stringContaining("did not finish") }),
    );
    lease.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals[2]?.aborted).toBe(true);
    expect(presence.release).toHaveBeenCalledTimes(1);
  });

  it("reports one failure per streak, and a failed release", async () => {
    const failure = new Error("offline");
    let up = false;
    const presence = deps({
      renew: vi.fn(async () => {
        if (!up) throw failure;
      }),
      release: vi.fn(async () => Promise.reject(failure)),
    });
    const lease = new PresenceLease("ports", 7, "Ports", presence);
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS * 2);
    expect(presence.report).toHaveBeenCalledTimes(1);
    up = true;
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS);
    up = false;
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS);
    expect(presence.report).toHaveBeenCalledTimes(2);
    lease.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(presence.report).toHaveBeenLastCalledWith(
      expect.stringContaining("could not be stopped right away"),
      failure,
    );
  });

  it("stops for good, silently, once its conversation is deleted elsewhere", async () => {
    const gone = serviceError(404, PLUGIN_TAB_ERROR.conversationNotFound, "conversation 7 is gone");
    const presence = deps({ renew: vi.fn(() => Promise.reject(gone)) });
    const lease = new PresenceLease("ports", 7, "Ports", presence);
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS * 5);
    expect(presence.renew).toHaveBeenCalledTimes(1);
    expect(presence.report).not.toHaveBeenCalled();
    // The service already took the lease back: closing has nothing to release.
    lease.dispose();
    await vi.advanceTimersByTimeAsync(PRESENCE_RERELEASE_MS);
    expect(presence.release).not.toHaveBeenCalled();
  });

  it("keeps renewing, silently, while its conversation is archived", async () => {
    const archived = serviceError(
      409,
      PLUGIN_TAB_ERROR.conversationArchived,
      "conversation 7 is archived",
    );
    let unarchived = false;
    const presence = deps({
      renew: vi.fn(() => (unarchived ? Promise.resolve() : Promise.reject(archived))),
    });
    new PresenceLease("ports", 7, "Ports", presence);
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS * 2);
    expect(presence.renew).toHaveBeenCalledTimes(3);
    unarchived = true;
    await vi.advanceTimersByTimeAsync(PRESENCE_RENEW_MS);
    expect(presence.renew).toHaveBeenCalledTimes(4);
    await expect(vi.mocked(presence.renew).mock.results[3]?.value).resolves.toBeUndefined();
    expect(presence.report).not.toHaveBeenCalled();
  });
});
