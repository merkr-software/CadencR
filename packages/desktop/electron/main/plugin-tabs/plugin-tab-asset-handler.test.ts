import { describe, expect, it, vi } from "vitest";

import { createPluginTabAssetHandler, PLUGIN_TAB_CSP } from "./plugin-tab-asset-handler";

const SERVICE_CSP = "default-src 'none'; connect-src 'none'";

function relay(response: Response | Error = new Response("<html></html>")) {
  const fetch = vi.fn(async (_input: string, _init: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  const handler = createPluginTabAssetHandler("graph", {
    getConfig: () => ({ baseUrl: "http://127.0.0.1:5005", authToken: "secret" }),
    fetch,
  });
  return { handler, fetch };
}

describe("createPluginTabAssetHandler", () => {
  it("relays a GET for the plugin's own host to the service with the main token", async () => {
    const upstream = new Response("console.log(1)", {
      status: 200,
      headers: {
        "content-type": "text/javascript",
        "content-security-policy": SERVICE_CSP,
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
        "set-cookie": "a=b",
        "content-encoding": "gzip",
      },
    });
    const { handler, fetch } = relay(upstream);

    const response = await handler(new Request("cadencr-tab://graph/assets/app.js?v=1"));

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5005/api/plugin-tabs/graph/assets/assets/app.js",
      { headers: { "x-cadencr-token": "secret" }, redirect: "manual" },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log(1)");
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("content-security-policy")).toBe(SERVICE_CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("asks for the entry with an empty asset path", async () => {
    const { handler, fetch } = relay();
    await handler(new Request("cadencr-tab://graph/"));
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:5005/api/plugin-tabs/graph/assets/");
  });

  it("preserves the upstream status (e.g. a missing asset)", async () => {
    const { handler } = relay(new Response("missing", { status: 404, statusText: "Not Found" }));
    const response = await handler(new Request("cadencr-tab://graph/nope.js"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("missing");
  });

  it("re-applies the contract CSP and nosniff when the service omitted them", async () => {
    const { handler } = relay(
      new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    );
    const response = await handler(new Request("cadencr-tab://graph/"));
    expect(response.headers.get("content-security-policy")).toBe(PLUGIN_TAB_CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(PLUGIN_TAB_CSP).toContain("connect-src 'none'");
  });

  it("refuses another plugin's host without contacting the service", async () => {
    const { handler, fetch } = relay();
    const response = await handler(new Request("cadencr-tab://other/"));
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses non-GET methods", async () => {
    const { handler, fetch } = relay();
    const response = await handler(
      new Request("cadencr-tab://graph/api", { method: "POST", body: "x" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers 502 with the reason when the service is unreachable", async () => {
    const { handler } = relay(new Error("connect ECONNREFUSED"));
    const response = await handler(new Request("cadencr-tab://graph/"));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("ECONNREFUSED");
  });

  it("omits the token header when no token is configured", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const handler = createPluginTabAssetHandler("graph", {
      getConfig: () => ({ baseUrl: "http://127.0.0.1:5005", authToken: null }),
      fetch,
    });
    await handler(new Request("cadencr-tab://graph/"));
    expect(fetch).toHaveBeenCalledWith(expect.any(String), { headers: {}, redirect: "manual" });
  });

  it("keeps null-body statuses body-less", async () => {
    const { handler } = relay(new Response(null, { status: 204 }));
    const response = await handler(new Request("cadencr-tab://graph/"));
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});
