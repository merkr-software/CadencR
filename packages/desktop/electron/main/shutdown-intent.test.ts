import { afterEach, describe, expect, it, vi } from "vitest";
import { stopLiveWorkForQuit, VoluntaryQuit, waitForStartupBeforeQuit } from "./shutdown-intent";

const BASE_URL = "http://127.0.0.1:5004";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shutdown intent", () => {
  it("asks the service to confirm the processes stopped", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);

    await stopLiveWorkForQuit(BASE_URL, "isolated-test-token");

    expect(request).toHaveBeenCalledExactlyOnceWith(
      `${BASE_URL}/api/restart-continuations/prepare-desktop-quit`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cadencr-token": "isolated-test-token",
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("refuses a quit if an older service cannot verify a live stop", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", request);
    await expect(stopLiveWorkForQuit(BASE_URL, null)).rejects.toThrow("returned 404");
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `${BASE_URL}/api/restart-continuations/prepare-desktop-quit`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("bounds the wait for a booting service and allows a retry once ready", async () => {
    vi.useFakeTimers();
    const startup = Promise.withResolvers<void>();
    const rejected = expect(waitForStartupBeforeQuit(startup.promise)).rejects.toThrow(
      "still starting",
    );
    await vi.runAllTimersAsync();
    await rejected;
    startup.resolve();
    await expect(waitForStartupBeforeQuit(startup.promise)).resolves.toBeUndefined();
  });

  it("reports a failed intent recording", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "Database unavailable" }, { status: 500 })),
    );
    await expect(stopLiveWorkForQuit(BASE_URL, null)).rejects.toThrow(
      "could not confirm that your agents stopped: Database unavailable",
    );
  });

  it("restores Browser persistence if the service cannot confirm the stop", async () => {
    const attempt = new VoluntaryQuit();
    const prepareQuit = vi.fn().mockRejectedValueOnce(new Error("reply lost"));
    const prepareBrowser = vi.fn(async () => {});
    const resumeBrowser = vi.fn();
    await expect(
      attempt.prepare({
        service: { prepareQuit },
        prepareBrowser,
        resumeBrowser,
      }),
    ).rejects.toThrow("reply lost");
    expect(prepareBrowser).toHaveBeenCalledBefore(prepareQuit);
    expect(resumeBrowser).toHaveBeenCalledOnce();
  });

  it("does not start an agent stop if the Browser cannot save", async () => {
    const prepareQuit = vi.fn();
    await expect(
      new VoluntaryQuit().prepare({
        service: { prepareQuit },
        prepareBrowser: vi.fn().mockRejectedValue(new Error("Browser write failed")),
        resumeBrowser: vi.fn(),
      }),
    ).rejects.toThrow("Browser write failed");
    expect(prepareQuit).not.toHaveBeenCalled();
  });

  it("can prepare the browser for exit when no live service is attached", async () => {
    const prepareBrowser = vi.fn(async () => {});
    await new VoluntaryQuit().prepare({
      service: null,
      prepareBrowser,
      resumeBrowser: vi.fn(),
    });
    expect(prepareBrowser).toHaveBeenCalledTimes(1);
  });

  it("waits for one durable decision, refuses the quit on error, and allows a retry", async () => {
    const attempt = new VoluntaryQuit();
    const checkpoint = Promise.withResolvers<void>();
    const record = vi.fn().mockReturnValueOnce(checkpoint.promise).mockResolvedValueOnce(undefined);
    const stop = vi.fn();
    const quit = async () => {
      await record();
      stop();
    };

    const first = attempt.run(quit);
    const second = attempt.run(quit);
    await Promise.resolve();
    expect(first).toBe(second);
    expect(attempt.inProgress).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    checkpoint.reject(new Error("disk unavailable"));
    await expect(first).rejects.toThrow("disk unavailable");
    expect(attempt.inProgress).toBe(false);
    expect(stop).not.toHaveBeenCalled();

    await attempt.run(quit);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
