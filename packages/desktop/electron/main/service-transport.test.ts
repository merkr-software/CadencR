import { describe, expect, it, vi } from "vitest";
vi.mock("./renderer-window-security", () => ({ rendererLoadTarget: vi.fn() }));
import { serviceRequestHeaders } from "./service-transport";

const config = { baseUrl: "http://127.0.0.1:5106", authToken: "main-process-secret" };
const target = { kind: "url", value: "http://127.0.0.1:1427/" } as const;
const frame = { processId: 2, routingId: 3, url: target.value };
const renderer = { id: 1, mainFrame: frame };
const request = {
  url: `${config.baseUrl}/api/projects`,
  webContentsId: 1,
  frame,
  resourceType: "xhr",
  requestHeaders: { "Content-Type": "application/octet-stream" },
};

describe("main-process sidecar credential broker", () => {
  it.each(["xhr", "image", "media", "other"])(
    "preserves headers and native %s transport",
    (resourceType) => {
      const headers = serviceRequestHeaders({ ...request, resourceType }, renderer, target, config);
      expect(headers).toEqual({
        "Content-Type": "application/octet-stream",
        "X-Cadencr-Token": config.authToken,
      });
      expect(request.requestHeaders).not.toHaveProperty("X-Cadencr-Token");
    },
  );

  it.each([
    "/ws",
    "/api/terminal/ws",
    "/api/neovim/ws",
    "/api/lsp/sessions/test/ws",
    "/api/plugin-tabs/ws",
  ])("authenticates websocket %s without a secret protocol", (path) => {
    const headers = serviceRequestHeaders(
      { ...request, resourceType: "webSocket", url: `ws://127.0.0.1:5106${path}` },
      renderer,
      target,
      config,
    );
    expect(headers["X-Cadencr-Token"]).toBe(config.authToken);
    expect(headers).not.toHaveProperty("Sec-WebSocket-Protocol");
  });

  it("strips bearer credentials on redirects and refuses alternate targets", () => {
    for (const url of [
      "https://evil.example/api/projects",
      "http://localhost:5106/api/projects",
      "http://127.0.0.1:5107/api/projects",
      `${config.baseUrl}/not-api`,
      "http://user@127.0.0.1:5106/api/projects",
    ]) {
      const headers = serviceRequestHeaders(
        { ...request, url, requestHeaders: { "x-Cadencr-token": config.authToken } },
        renderer,
        target,
        config,
      );
      expect(Object.values(headers), url).not.toContain(config.authToken);
    }
  });

  it("refuses guests, subframes, missing frames and navigated renderers", () => {
    for (const change of [
      { webContentsId: 2 },
      { frame: null },
      { frame: undefined },
      { frame: { ...frame, routingId: 4 } },
      { frame: { ...frame, processId: 5 } },
      { frame: { ...frame, url: "http://127.0.0.1:9999/" } },
      { resourceType: "mainFrame" },
      { resourceType: "subFrame" },
    ])
      expect(
        serviceRequestHeaders({ ...request, ...change }, renderer, target, config),
      ).not.toHaveProperty("X-Cadencr-Token");
    expect(serviceRequestHeaders(request, null, target, config)).not.toHaveProperty(
      "X-Cadencr-Token",
    );
    expect(
      serviceRequestHeaders(
        request,
        { ...renderer, mainFrame: { ...frame, url: "https://evil.example" } },
        target,
        config,
      ),
    ).not.toHaveProperty("X-Cadencr-Token");
  });

  it("preserves scoped plugin authentication without adding a conflicting launch bearer", () => {
    const headers = serviceRequestHeaders(
      { ...request, requestHeaders: { "X-Cadencr-Plugin-Token": "grant" } },
      renderer,
      target,
      config,
    );
    expect(headers).toEqual({ "X-Cadencr-Plugin-Token": "grant" });
  });
});
