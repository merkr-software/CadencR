import { describe, expect, it } from "vitest";
import { CadencrError } from "./errors.js";
import { createPluginFetch, pluginFetch } from "./fetcher.js";
import { connected } from "./test-utils.js";
import { jsonResponse } from "./testing/index.js";
import { windowPortSource, type PortWindow } from "./transport.js";

describe("api", () => {
  it("resolves non-2xx from request() and exposes body readers", async () => {
    const { host, client } = await connected();
    host.route("GET", "/api/features/10", jsonResponse(200, { id: 10 }));
    const ok = await client.api.request({ method: "GET", path: "/api/features/10" });
    expect(ok.ok).toBe(true);
    await expect(ok.json()).resolves.toEqual({ id: 10 });
    await expect(ok.json()).resolves.toEqual({ id: 10 });
    expect(ok.headers["content-type"]).toBe("application/json");
    const missing = await client.api.request({ method: "GET", path: "/api/nope" });
    expect(missing.status).toBe(404);
    expect(missing.ok).toBe(false);
    client.close();
    host.close();
  });

  it("sends JSON bodies and encoded queries", async () => {
    const { host, client } = await connected();
    host.route("POST", "/api/things", (request) => jsonResponse(201, request));
    const echoed = await client.api.post<{ body: string; query: Record<string, string> }>(
      "/api/things",
      { name: "x" },
      { query: { project_id: 4, all: true, skip: undefined, none: null } },
    );
    expect(JSON.parse(echoed.body)).toEqual({ name: "x" });
    expect(echoed.query).toEqual({ project_id: "4", all: "true" });
    client.close();
    host.close();
  });

  it("maps the service error body onto CadencrError", async () => {
    const { host, client } = await connected();
    host.route(
      "GET",
      "/api/git/status",
      jsonResponse(403, { error: "Scope git:read not granted", code: "PLUGIN_SCOPE_DENIED" }),
    );
    host.route("DELETE", "/api/x", { status: 400, headers: {}, body: null });
    host.route("PUT", "/api/y", { status: 204, headers: {}, body: null });
    const error = await client.api.get("/api/git/status").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CadencrError);
    expect(error).toMatchObject({
      code: "PLUGIN_SCOPE_DENIED",
      status: 403,
      message: "Scope git:read not granted",
    });
    await expect(client.api.delete("/api/x")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
    });
    await expect(client.api.get("/api/missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.api.put("/api/y", { a: 1 })).resolves.toBeUndefined();
    client.close();
    host.close();
  });

  it("serves the generated-client mutator", async () => {
    const { host, client } = await connected();
    host.route("PATCH", "/api/z", (request) =>
      jsonResponse(200, { query: request.query, body: request.body }),
    );
    const fetcher = createPluginFetch(client);
    await expect(
      fetcher("/api/z?a=1&b=two", { method: "patch", body: JSON.stringify({ k: 1 }) }),
    ).resolves.toEqual({ query: { a: "1", b: "two" }, body: '{"k":1}' });
    await expect(pluginFetch("/api/z", { method: "PATCH" })).resolves.toEqual({
      query: {},
    });
    await expect(fetcher("/api/z", { method: "TRACE" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    client.close();
    await expect(pluginFetch("/api/z")).rejects.toMatchObject({ code: "DISCONNECTED" });
    host.close();
  });
});

describe("windowPortSource", () => {
  it("accepts only the port message posted by the window itself", () => {
    const target = new EventTarget();
    const win: PortWindow = {
      addEventListener: (type, listener) =>
        target.addEventListener(type, (event) => listener(event as unknown as MessageEvent)),
    };
    const ports: MessagePort[] = [];
    const source = windowPortSource(win);
    expect(windowPortSource(win)).toBe(source);
    source.subscribe((port) => ports.push(port));
    const { port1, port2 } = new MessageChannel();
    const post = (data: unknown, from: unknown) =>
      target.dispatchEvent(
        Object.assign(new Event("message"), { data, ports: [port1], source: from }),
      );
    post({ type: "cadencr-tab:port" }, {});
    post({ type: "other" }, win);
    post({ type: "cadencr-tab:port" }, win);
    expect(ports).toEqual([port1]);
    const late: MessagePort[] = [];
    source.subscribe((port) => late.push(port));
    expect(late).toEqual([port1]);
    port1.close();
    port2.close();
  });
});
