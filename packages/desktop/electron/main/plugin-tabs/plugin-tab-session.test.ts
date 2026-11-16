import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";

import { parseInstanceId, parsePluginId, pluginTabPartition } from "./plugin-tab-ids";
import {
  hardenPluginTabSession,
  isAllowedPluginTabRequest,
  PluginTabSessions,
} from "./plugin-tab-session";

type Callback = (...args: unknown[]) => unknown;

function fakeSession() {
  const handlers: Record<string, Callback> = {};
  const capture =
    (name: string) =>
    (handler: Callback): void => {
      handlers[name] = handler;
    };
  const ses = {
    setPermissionRequestHandler: vi.fn(capture("permissionRequest")),
    setPermissionCheckHandler: vi.fn(capture("permissionCheck")),
    setDevicePermissionHandler: vi.fn(capture("devicePermission")),
    webRequest: { onBeforeRequest: vi.fn(capture("beforeRequest")) },
    on: vi.fn((event: string, handler: Callback) => capture(event)(handler)),
    setSpellCheckerEnabled: vi.fn(),
    protocol: { handle: vi.fn() },
  };
  return { ses, handlers, asSession: ses as unknown as Session };
}

describe("plugin tab ids", () => {
  it("accepts manifest ids and rejects anything that is not a host label", () => {
    expect(parsePluginId("changed-files-graph")).toBe("changed-files-graph");
    for (const bad of ["", "-x", "x-", "Upper", "a/b", "a.b", "x".repeat(65), 7, null]) {
      expect(() => parsePluginId(bad)).toThrow("Expected a custom tab id.");
    }
  });

  it("validates opaque instance ids", () => {
    expect(parseInstanceId("12:plugin:graph")).toBe("12:plugin:graph");
    expect(() => parseInstanceId("a b")).toThrow();
    expect(() => parseInstanceId("")).toThrow();
    expect(() => parseInstanceId({})).toThrow();
  });

  it("isolates every plugin in its own persistent partition", () => {
    expect(pluginTabPartition("graph")).toBe("persist:cadencr-tab:graph");
  });
});

describe("isAllowedPluginTabRequest", () => {
  it("allows only the plugin's own scheme host, DevTools and in-process URLs", () => {
    expect(isAllowedPluginTabRequest("cadencr-tab://graph/app.js", "graph")).toBe(true);
    expect(isAllowedPluginTabRequest("devtools://devtools/bundled/x.js", "graph")).toBe(true);
    expect(isAllowedPluginTabRequest("data:image/png;base64,AA==", "graph")).toBe(true);
    expect(isAllowedPluginTabRequest("blob:cadencr-tab://graph/uuid", "graph")).toBe(true);
    expect(isAllowedPluginTabRequest("cadencr-tab://other/app.js", "graph")).toBe(false);
    expect(isAllowedPluginTabRequest("https://example.com/", "graph")).toBe(false);
    expect(isAllowedPluginTabRequest("http://127.0.0.1:5005/api/projects", "graph")).toBe(false);
    expect(isAllowedPluginTabRequest("ws://127.0.0.1:5005/ws", "graph")).toBe(false);
    expect(isAllowedPluginTabRequest("file:///etc/passwd", "graph")).toBe(false);
    expect(isAllowedPluginTabRequest("chrome-extension://abc/x.js", "graph")).toBe(false);
  });
});

describe("hardenPluginTabSession", () => {
  it("denies permissions, devices, downloads, foreign requests and spellcheck", () => {
    const { ses, handlers, asSession } = fakeSession();
    hardenPluginTabSession(asSession, "graph");

    const permissionCallback = vi.fn();
    handlers.permissionRequest?.(null, "media", permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);
    expect(handlers.permissionCheck?.(null, "clipboard-read")).toBe(false);
    expect(handlers.devicePermission?.({})).toBe(false);

    const requestCallback = vi.fn();
    handlers.beforeRequest?.({ url: "https://example.com/" }, requestCallback);
    expect(requestCallback).toHaveBeenLastCalledWith({ cancel: true });
    handlers.beforeRequest?.({ url: "cadencr-tab://graph/" }, requestCallback);
    expect(requestCallback).toHaveBeenLastCalledWith({ cancel: false });

    const download = { preventDefault: vi.fn() };
    handlers["will-download"]?.(download);
    expect(download.preventDefault).toHaveBeenCalled();
    expect(ses.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
  });
});

describe("PluginTabSessions", () => {
  it("prepares each partition once and installs the plugin's own asset handler", () => {
    const { ses, asSession } = fakeSession();
    const handler = vi.fn();
    const fromPartition = vi.fn(() => asSession);
    const createAssetHandler = vi.fn(() => handler);
    const sessions = new PluginTabSessions({ fromPartition, createAssetHandler });

    expect(sessions.prepare("graph")).toBe(asSession);
    expect(sessions.prepare("graph")).toBe(asSession);

    expect(fromPartition).toHaveBeenCalledTimes(1);
    expect(fromPartition).toHaveBeenCalledWith("persist:cadencr-tab:graph");
    expect(createAssetHandler).toHaveBeenCalledWith("graph");
    expect(ses.protocol.handle).toHaveBeenCalledTimes(1);
    expect(ses.protocol.handle).toHaveBeenCalledWith("cadencr-tab", handler);
  });
});
