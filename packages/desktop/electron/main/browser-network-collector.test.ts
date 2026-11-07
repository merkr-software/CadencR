import { describe, expect, it, vi } from "vitest";
import { BrowserNetworkCollector } from "./browser-network-collector";
import { setBrowserOriginPolicyReady, setBrowserRemoteOrigins } from "./runtime-config";
import type { BrowserNetworkEntry } from "./browser-types";

type CollectedEntry = Omit<BrowserNetworkEntry, "tabId">;

interface MockSession {
  handlers: Record<string, (details: unknown) => void>;
  webRequest: {
    onBeforeRequest: ReturnType<typeof vi.fn>;
    onBeforeSendHeaders: ReturnType<typeof vi.fn>;
    onCompleted: ReturnType<typeof vi.fn>;
    onErrorOccurred: ReturnType<typeof vi.fn>;
  };
}

function mockSession(): MockSession {
  const handlers: Record<string, (details: unknown) => void> = {};
  return {
    handlers,
    webRequest: {
      onBeforeRequest: vi.fn(),
      onBeforeSendHeaders: vi.fn((cb: (d: unknown) => void) => (handlers.beforeSend = cb)),
      onCompleted: vi.fn((cb: (d: unknown) => void) => (handlers.completed = cb)),
      onErrorOccurred: vi.fn((cb: (d: unknown) => void) => (handlers.error = cb)),
    },
  };
}

function asSession(mock: MockSession): Electron.Session {
  return mock as unknown as Electron.Session;
}

describe("BrowserNetworkCollector", () => {
  it("blocks automated self requests but preserves human browsing and normal dev sites", () => {
    setBrowserRemoteOrigins(["https://127.0.0.1:9123", "https://tunnel.example.test"]);
    let automated = true;
    const collector = new BrowserNetworkCollector(
      () => undefined,
      () => automated,
    );
    const session = mockSession();
    collector.ensure(asSession(session));
    const request = session.webRequest.onBeforeRequest.mock.calls[0][0] as (
      details: { url: string; webContentsId: number },
      callback: (result: { cancel: boolean }) => void,
    ) => void;
    for (const url of [
      "http://localhost:5005/api/remote/pairing-code",
      "https://100.1.2.3:9123/",
      "https://tunnel.example.test/",
    ]) {
      const callback = vi.fn();
      request({ url, webContentsId: 7 }, callback);
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
    const callback = vi.fn();
    request({ url: "http://localhost:3000/", webContentsId: 7 }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: false });
    automated = false;
    request({ url: "http://localhost:5005/", webContentsId: 7 }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: false });
    automated = true;
    setBrowserOriginPolicyReady(false);
    request({ url: "http://localhost:3000/", webContentsId: 7 }, callback);
    expect(callback).toHaveBeenLastCalledWith({ cancel: true });
  });
  it("emits an entry for completed requests, keyed by webContents id", () => {
    const seen: Array<{ id: number; entry: CollectedEntry }> = [];
    const collector = new BrowserNetworkCollector((id, entry) => seen.push({ id, entry }));
    const session = mockSession();
    collector.ensure(asSession(session));

    session.handlers.completed({
      id: 1,
      webContentsId: 7,
      method: "GET",
      url: "http://localhost/api",
      statusCode: 200,
      responseHeaders: {},
      resourceType: "xhr",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(7);
    expect(seen[0].entry.status).toBe(200);
    expect(seen[0].entry.url).toBe("http://localhost/api");
  });

  it("skips requests that cannot be attributed to a tab", () => {
    const seen: CollectedEntry[] = [];
    const collector = new BrowserNetworkCollector((_id, entry) => seen.push(entry));
    const session = mockSession();
    collector.ensure(asSession(session));

    session.handlers.error({
      id: 2,
      method: "GET",
      url: "http://localhost/y",
      error: "net::ERR_FAILED",
      resourceType: "xhr",
    });

    expect(seen).toHaveLength(0);
  });

  it("instruments each session only once", () => {
    const collector = new BrowserNetworkCollector(() => undefined);
    const session = mockSession();
    collector.ensure(asSession(session));
    collector.ensure(asSession(session));
    expect(session.webRequest.onCompleted).toHaveBeenCalledTimes(1);
  });

  it("releases the headers of requests no tab owns", () => {
    const seen: CollectedEntry[] = [];
    const collector = new BrowserNetworkCollector((_id, entry) => seen.push(entry));
    const session = mockSession();
    collector.ensure(asSession(session));

    const beforeSend = session.webRequest.onBeforeSendHeaders.mock.calls[0][0] as (
      details: { id: number; requestHeaders: Record<string, string> },
      callback: (result: unknown) => void,
    ) => void;
    beforeSend({ id: 42, requestHeaders: { Accept: "text/html" } }, vi.fn());
    // A service worker or the session itself: no webContents, no entry.
    session.handlers.completed({ id: 42, method: "GET", url: "https://a.test/", statusCode: 200 });
    expect(seen).toEqual([]);

    // Were they still cached, a later request reusing the id would get them.
    session.handlers.completed({
      id: 42,
      webContentsId: 7,
      method: "GET",
      url: "https://a.test/",
      statusCode: 200,
    });
    expect(seen[0]?.requestHeaders).toEqual({});
  });
});
