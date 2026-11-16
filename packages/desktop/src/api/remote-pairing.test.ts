// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDeviceTokenMemoryForTests } from "@/lib/remote/device-token";
import { ensurePaired, pairRemoteDevice, takeJustPaired, takePairingError } from "./remote-pairing";

const KEY = "cadencr.remoteDeviceToken";

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function mockResponse(status: number, body: unknown): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function stubLocation(search: string, hash = "", pathname = "/"): void {
  vi.stubGlobal("location", {
    protocol: "https:",
    origin: "https://192.168.1.5:5006",
    pathname,
    search,
    hash,
  });
}

function resetRemotePairingTestState(): void {
  Reflect.deleteProperty(window, "cadencr");
  localStorage.clear();
  sessionStorage.clear();
  __resetDeviceTokenMemoryForTests();
}

describe("ensurePaired", () => {
  let replaceState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetRemotePairingTestState();
    replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("exchanges a code, stores the token session-only, flags just-paired, and strips ?code=", async () => {
    stubLocation("?code=abc123");
    const fetchMock = vi.fn(() =>
      Promise.resolve(mockResponse(200, { device_token: "dev-tok", label: "Remote device" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await ensurePaired();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://192.168.1.5:5006/api/remote/pair",
      expect.objectContaining({ method: "POST" }),
    );
    // Session-only by default — persistence is opted into on the device, not here.
    expect(sessionStorage.getItem(KEY)).toBe("dev-tok");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(takeJustPaired()).toBe("session");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it.each([
    [
      "?view=list",
      "#code=fragment-code&trust=1&tab=agent",
      "/projects/7?view=list#tab=agent",
      "fragment-code",
    ],
    [
      "?code=legacy&view=list",
      "#/projects/7?tab=agent",
      "/projects/7?view=list#/projects/7?tab=agent",
      "legacy",
    ],
    [
      "?code=legacy&view=list",
      "#/projects/7?code=fragment&tab=agent&trust=1",
      "/projects/7?view=list#/projects/7?tab=agent",
      "fragment",
    ],
  ])(
    "scrubs pairing values before fetch and preserves unrelated URL state",
    async (query, hash, cleaned, code) => {
      stubLocation(query, hash, "/projects/7");
      const fetchMock = vi.fn(() => {
        expect(replaceState).toHaveBeenCalledWith(null, "", cleaned);
        return Promise.resolve(mockResponse(200, { device_token: "t", label: "x" }));
      });
      vi.stubGlobal("fetch", fetchMock);
      await ensurePaired();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify({ code }) }),
      );
      expect(localStorage.getItem(KEY)).toBeNull();
    },
  );

  it("strips a malformed percent-encoded fragment without crashing or sending it", async () => {
    stubLocation("?view=list", "#code=%E0%A4%A&tab=agent");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await ensurePaired();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?view=list#tab=agent");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(takePairingError()).toMatch(/malformed/i);
  });

  it("does not send the code if URL cleanup fails", async () => {
    stubLocation("?code=secret");
    replaceState.mockImplementation(() => {
      throw new Error("blocked");
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await ensurePaired();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(takePairingError()).toMatch(/pairing was stopped/i);
  });

  it("ignores a legacy host trust flag (decision is the device's) and strips it", async () => {
    stubLocation("?code=abc&trust=1");
    vi.stubGlobal("fetch", () =>
      Promise.resolve(mockResponse(200, { device_token: "t", label: "x" })),
    );
    await ensurePaired();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBe("t");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("no-ops (no fetch) when there is no code", async () => {
    stubLocation("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await ensurePaired();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stashes a friendly error on 400, does not flag just-paired, and strips the code", async () => {
    stubLocation("?code=expired");
    vi.stubGlobal("fetch", () => Promise.resolve(mockResponse(400, {})));
    await ensurePaired();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(takeJustPaired()).toBe(null);
    expect(takePairingError()).toMatch(/expired/i);
    expect(replaceState).toHaveBeenCalled();
  });
});

describe("pairRemoteDevice", () => {
  beforeEach(() => {
    resetRemotePairingTestState();
    stubLocation("");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults manual/QR pairing to session storage without implicit trust", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(mockResponse(200, { device_token: "session-token", label: "x" })),
    );
    await pairRemoteDevice("abc123");
    expect(sessionStorage.getItem(KEY)).toBe("session-token");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(takeJustPaired()).toBe("session");
  });

  it("exchanges a code and stores trusted devices durably", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(mockResponse(200, { device_token: "trusted-token", label: "iPhone" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const paired = await pairRemoteDevice("abc123", { trust: true });

    expect(paired.storagePersisted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://192.168.1.5:5006/api/remote/pair",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "abc123" }),
      }),
    );
    expect(localStorage.getItem(KEY)).toBe("trusted-token");
    expect(sessionStorage.getItem(KEY)).toBeNull();
    // The gate path (used by an installed PWA) must flag the post-pair toast
    // too, as "trusted" — otherwise the PWA shows no pairing feedback.
    expect(takeJustPaired()).toBe("trusted");
  });

  it("rejects malformed pairing responses before writing storage", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(mockResponse(200, { label: "missing token" })));

    await expect(pairRemoteDevice("abc123", { trust: true })).rejects.toThrow(/malformed/i);

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});
