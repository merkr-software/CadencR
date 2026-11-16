import { describe, expect, it } from "vitest";
import { devServiceProxy, isDevServiceRequest } from "./dev-service-proxy";

const origin = "http://127.0.0.1:1427";
const host = "127.0.0.1:1427";

describe("development browser service proxy", () => {
  it("requires the exact Host and Origin for cross-origin requests and websockets", () => {
    expect(isDevServiceRequest({ host, origin }, origin)).toBe(true);
    for (const headers of [
      { host },
      { host, origin: "http://127.0.0.1:1428" },
      { host: "localhost:1427", origin },
      { host: "evil.example:1427", origin },
      { host, origin: "null" },
      { host, origin: "http://127.0.0.1:1427.evil.example" },
      {
        host,
        origin: "https://evil.example",
        referer: `${origin}/`,
        "sec-fetch-site": "same-origin",
      },
    ])
      expect(isDevServiceRequest(headers, origin)).toBe(false);
  });

  it("permits same-origin GET without Origin only with trusted Referer and browser metadata", () => {
    expect(
      isDevServiceRequest(
        { host, referer: `${origin}/projects/1`, "sec-fetch-site": "same-origin" },
        origin,
      ),
    ).toBe(true);
    for (const headers of [
      { host, referer: `${origin}/` },
      { host, "sec-fetch-site": "same-origin" },
      { host, referer: `${origin}/`, "sec-fetch-site": "same-site" },
      { host, referer: "http://localhost:1427/", "sec-fetch-site": "same-origin" },
      { host, referer: "https://evil.example/", "sec-fetch-site": "same-origin" },
    ])
      expect(isDevServiceRequest(headers, origin)).toBe(false);
  });

  it("keeps bearer injection server-only and disables authenticated redirects", () => {
    const { proxy } = devServiceProxy(origin, "http://127.0.0.1:5106", "secret");
    for (const path of ["/api", "/ws", "/health"]) {
      const route = proxy[path];
      expect(route.followRedirects).toBe(false);
      expect(route.headers).toBeUndefined();
      expect(route.ws).toBe(true);
    }
  });

  it("passes the public visual sandbox shell through without the bearer", () => {
    const { proxy } = devServiceProxy(origin, "http://127.0.0.1:5106", "secret");
    const route = proxy["/visual-frame"];
    expect(route.target).toBe("http://127.0.0.1:5106");
    expect(route.configure).toBeUndefined();
    expect(route.headers).toBeUndefined();
    expect(route.followRedirects).toBe(false);
  });
});
