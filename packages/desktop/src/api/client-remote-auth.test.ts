import { AxiosError, type AxiosAdapter } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A remote browser whose device token lives here, so a test can pair (swap the
// token) while a request is in flight.
const device = vi.hoisted(() => ({ token: null as string | null, cleared: 0 }));
vi.mock("@/lib/remote/device-token", () => ({
  isBrowserRemote: () => true,
  readDeviceToken: () => device.token,
  clearDeviceToken: () => {
    device.cleared += 1;
    device.token = null;
  },
}));

import { customInstance } from "./client";

function unauthorizedAfter(release: Promise<void>, onSent?: () => void): AxiosAdapter {
  return async (config) => {
    onSent?.();
    await release;
    throw new AxiosError("Request failed with status code 401", "ERR_BAD_REQUEST", config, null, {
      data: { error: "unauthorized" },
      status: 401,
      statusText: "Unauthorized",
      headers: {},
      config,
    });
  };
}

beforeEach(() => {
  device.token = null;
  device.cleared = 0;
});

describe("a 401 in a remote browser", () => {
  it("drops the token the request carried", async () => {
    device.token = "revoked";
    await customInstance({ url: "/api/x", adapter: unauthorizedAfter(Promise.resolve()) }).catch(
      () => undefined,
    );
    expect(device.cleared).toBe(1);
    expect(device.token).toBeNull();
  });

  it("keeps a new token when a request carrying a revoked one fails after re-pairing", async () => {
    device.token = "revoked";
    let answer: () => void = () => undefined;
    let sent: () => void = () => undefined;
    const onTheWire = new Promise<void>((resolve) => (sent = resolve));
    const pending = customInstance({
      url: "/api/x",
      adapter: unauthorizedAfter(new Promise((resolve) => (answer = resolve)), sent),
    }).catch(() => undefined);
    await onTheWire;
    device.token = "fresh";
    answer();
    await pending;
    expect(device.cleared).toBe(0);
    expect(device.token).toBe("fresh");
  });

  it("keeps a token saved by pairing while an older request was in flight", async () => {
    let answer: () => void = () => undefined;
    let sent: () => void = () => undefined;
    const onTheWire = new Promise<void>((resolve) => (sent = resolve));
    const pending = customInstance({
      url: "/api/workspace/settings",
      adapter: unauthorizedAfter(new Promise((resolve) => (answer = resolve)), sent),
    }).catch(() => undefined);
    // Sent unpaired; pairing saves a token before the service's 401 comes back.
    await onTheWire;
    device.token = "fresh";
    answer();
    await pending;
    expect(device.cleared).toBe(0);
    expect(device.token).toBe("fresh");
  });
});
