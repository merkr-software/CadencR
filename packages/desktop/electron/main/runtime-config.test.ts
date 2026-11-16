import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserDeniedOrigins,
  getRuntimeConfig,
  getRendererRuntimeConfig,
  isBrowserOriginPolicyReady,
  refreshBrowserOriginPolicy,
  setRuntimeConfig,
} from "./runtime-config";

afterEach(() => vi.unstubAllGlobals());

describe("runtime-config", () => {
  it("keeps the credential main-only when projecting runtime IPC data", () => {
    setRuntimeConfig({ baseUrl: "http://127.0.0.1:5004", authToken: "token" });
    expect(getRuntimeConfig()).toEqual({ baseUrl: "http://127.0.0.1:5004", authToken: "token" });
    expect(getRendererRuntimeConfig()).toEqual({ baseUrl: "http://127.0.0.1:5004" });
    expect(JSON.stringify(getRendererRuntimeConfig())).not.toContain("token");
  });

  it("learns the actual dynamic remote listener port and tunnel origin", async () => {
    setRuntimeConfig({ baseUrl: "http://127.0.0.1:5106", authToken: "secret" });
    const fetchStatus = vi.fn(async () =>
      Response.json({
        enabled: true,
        port: 62345,
        lan_urls: ["https://192.168.1.5:62345/"],
        tunnel_host: "example.ts.net",
      }),
    );
    vi.stubGlobal("fetch", fetchStatus);
    expect(isBrowserOriginPolicyReady()).toBe(false);
    await Promise.all([refreshBrowserOriginPolicy(), refreshBrowserOriginPolicy()]);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledWith(
      "http://127.0.0.1:5106/api/remote/browser-origins",
      expect.objectContaining({ headers: { "x-cadencr-token": "secret" }, redirect: "error" }),
    );
    expect(isBrowserOriginPolicyReady()).toBe(true);
    expect(getBrowserDeniedOrigins()).toEqual(
      expect.arrayContaining([
        "https://127.0.0.1:62345",
        "https://192.168.1.5:62345/",
        "https://example.ts.net",
      ]),
    );
  });

  it("fails closed when the service disappears or listener metadata is incomplete", async () => {
    setRuntimeConfig({ baseUrl: "http://127.0.0.1:5106", authToken: "secret" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ enabled: false, port: null, lan_urls: [], tunnel_host: null }),
      ),
    );
    await refreshBrowserOriginPolicy();
    expect(isBrowserOriginPolicyReady()).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ enabled: true, port: null, lan_urls: [], tunnel_host: null }),
      ),
    );
    await expect(refreshBrowserOriginPolicy()).rejects.toThrow(
      "listener origins could not be verified",
    );
    expect(isBrowserOriginPolicyReady()).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(refreshBrowserOriginPolicy()).rejects.toThrow(
      "listener origins could not be verified",
    );
    expect(isBrowserOriginPolicyReady()).toBe(false);
  });
});
