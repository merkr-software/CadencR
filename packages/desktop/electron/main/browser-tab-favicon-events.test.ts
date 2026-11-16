import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { metadataFor } from "./browser-manager-utils";
import type { ManagedTab, TabEventHost } from "./browser-tab-events";
import { installBrowserFaviconEvents } from "./browser-tab-favicon-events";

function pngResponse(): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { "content-type": "image/png" },
  });
}

function setup() {
  const contents = Object.assign(new EventEmitter(), {
    getURL: vi.fn(() => "https://example.com/page"),
    isDestroyed: vi.fn(() => false),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => [] as string[]),
    session: { fetch: vi.fn(async () => pngResponse()) },
  });
  const tab = {
    metadata: metadataFor("tab-1", "default", 1),
    webContents: contents,
    pendingSessionTasks: new Set<Promise<void>>(),
  } as unknown as ManagedTab;
  let error: string | null = "Previous failure";
  const emitState = vi.fn(() => ({ error, loading: tab.metadata.loading }));
  const host = {
    emitState,
    setTabError: vi.fn((message: string | null) => {
      const changed = error !== message;
      error = message;
      return changed;
    }),
    invalidateFind: vi.fn(),
    isTabAlive: () => true,
  } as unknown as TabEventHost;
  installBrowserFaviconEvents(tab, host);
  return { contents, tab, host, emitState };
}

async function flush(tab: ManagedTab): Promise<void> {
  await Promise.all([...tab.pendingSessionTasks]);
}

describe("installBrowserFaviconEvents", () => {
  it("clears the previous error before publishing the first loading state", () => {
    const { contents, tab, host, emitState } = setup();
    tab.metadata.faviconUrl = "data:image/png;base64,b2xk";
    contents.emit("did-start-loading");
    expect(host.invalidateFind).toHaveBeenCalledOnce();
    expect(emitState).toHaveBeenCalledOnce();
    expect(emitState.mock.results[0]?.value).toEqual({ error: null, loading: true });
    expect(tab.metadata.faviconUrl).toBeUndefined();
  });

  it("tracks recovery once across both discovery and fetching", async () => {
    const { contents, tab } = setup();
    let finishQuery!: (urls: string[]) => void;
    let finishFetch!: (response: Response) => void;
    contents.executeJavaScriptInIsolatedWorld.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishQuery = resolve;
        }),
    );
    contents.session.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFetch = resolve;
        }),
    );
    contents.emit("did-stop-loading");
    expect(tab.pendingSessionTasks.size).toBe(1);
    finishQuery(["https://example.com/icon.png"]);
    await vi.waitFor(() => expect(contents.session.fetch).toHaveBeenCalledOnce());
    expect(tab.pendingSessionTasks.size).toBe(1);
    finishFetch(pngResponse());
    await flush(tab);
    expect(tab.pendingSessionTasks.size).toBe(0);
    expect(tab.metadata.faviconUrl).toMatch(/^data:image\/png/);
  });

  it("does not fetch the same failed candidate repeatedly", async () => {
    const { contents, tab } = setup();
    contents.session.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    contents.emit("page-favicon-updated", {}, [
      "https://example.com/missing.png",
      "https://example.com/missing.png",
      "https://example.com/icon.png",
    ]);
    await flush(tab);
    expect(contents.session.fetch).toHaveBeenCalledTimes(2);
    expect(tab.metadata.faviconUrl).toMatch(/^data:image\/png/);
  });

  it("bounds icon URL reads in the guest before returning them to the main process", async () => {
    const { contents, tab } = setup();
    const readHref = vi.fn(() => "https://example.com/icon.png");
    const links = Array.from({ length: 100 }, () => ({
      get href() {
        return readHref();
      },
    }));
    contents.executeJavaScriptInIsolatedWorld.mockImplementation(async (...args: unknown[]) => {
      const scripts = args[1] as Array<{ code: string }>;
      return runInNewContext(scripts[0].code, {
        document: { querySelectorAll: () => links },
      }) as string[];
    });
    contents.emit("did-stop-loading");
    await flush(tab);
    expect(readHref).toHaveBeenCalledTimes(8);
  });

  it("does not inspect or fetch icons for a blank tab", async () => {
    const { contents, tab } = setup();
    contents.getURL.mockReturnValue("about:blank");
    contents.emit("did-stop-loading");
    await flush(tab);
    expect(contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(contents.session.fetch).not.toHaveBeenCalled();
  });

  it("does not replace a main-page load failure with a favicon recovery error", async () => {
    const { contents, tab } = setup();
    contents.emit("did-start-loading");
    contents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", contents.getURL(), true);
    contents.emit("did-stop-loading");
    await flush(tab);
    expect(contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(contents.session.fetch).not.toHaveBeenCalled();
  });

  it("still recovers the page favicon when only a subframe fails", async () => {
    const { contents, tab } = setup();
    contents.emit("did-start-loading");
    contents.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      "https://subframe.example",
      false,
    );
    contents.emit("did-stop-loading");
    await flush(tab);
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
    expect(tab.metadata.faviconUrl).toMatch(/^data:image\/png/);
  });
});
