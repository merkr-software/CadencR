import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserAgentAccessController } from "./browser-agent-access-controller";
import { metadataFor } from "./browser-manager-utils";
import { createBrowserProfile } from "./browser-profiles";
import { setBrowserRemoteOrigins } from "./runtime-config";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserAgentAccess, BrowserAgentAccessRequest } from "./browser-types";

interface FakeTabHandle {
  tab: ManagedTab;
  emitter: EventEmitter;
  setUrl: (url: string) => void;
  destroy: () => void;
}

function makeTab(
  id: string,
  options: {
    url?: string;
    title?: string;
    scopeId?: number | null;
    access?: BrowserAgentAccess;
    mode?: "persistent" | "fresh" | "feature";
    isActive?: boolean;
  } = {},
): FakeTabHandle {
  let url = options.url ?? "https://app.example.com/dashboard";
  let destroyed = false;
  const emitter = new EventEmitter();
  const webContents = Object.assign(emitter, {
    getURL: () => url,
    isDestroyed: () => destroyed,
  }) as unknown as WebContents;
  const mode = options.mode ?? "persistent";
  const profile = createBrowserProfile(
    mode,
    mode === "persistent" ? "default" : mode === "fresh" ? "private-1" : "feature",
  );
  const scopeId = options.scopeId === undefined ? 7 : options.scopeId;
  const metadata = {
    ...metadataFor(id, mode === "persistent" ? "default" : mode, scopeId),
    url,
    title: options.title ?? "Dashboard",
    isActive: options.isActive ?? false,
    agentAccess: options.access ?? "user",
  };
  const tab = {
    metadata,
    profile,
    automationAccess: options.access ?? "user",
    externalAutomationOrigin: null,
    webContents,
  } as unknown as ManagedTab;
  return {
    tab,
    emitter,
    setUrl: (next) => {
      url = next;
      tab.metadata = { ...tab.metadata, url: next };
    },
    destroy: () => {
      destroyed = true;
      emitter.emit("destroyed");
    },
  };
}

function createController(
  requestTimeoutMs = 120_000,
  suspendFocusGuard?: <T>(action: () => Promise<T>) => Promise<T>,
) {
  const send = vi.fn();
  const activateTab = vi.fn(async (tabId: string) => ({
    ...metadataFor(tabId, "default", 7),
    isActive: true,
  }));
  const emitState = vi.fn();
  const controller = new BrowserAgentAccessController({
    send,
    activateTab,
    emitState,
    suspendFocusGuard,
    requestTimeoutMs,
  });
  return { controller, send, activateTab, emitState };
}

beforeEach(() => {
  setBrowserRemoteOrigins(["https://tunnel.example.test"]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserAgentAccessController", () => {
  it("returns immediately for already shared or agent tabs", async () => {
    const { controller, send, activateTab } = createController();
    const shared = makeTab("tab-shared", { access: "shared" });
    const agent = makeTab("tab-agent", { access: "agent" });

    await expect(controller.requestAccess(shared.tab)).resolves.toBeUndefined();
    await expect(controller.requestAccess(agent.tab)).resolves.toBeUndefined();

    expect(activateTab).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects immediately when scopeId is null or tab is destroyed", async () => {
    const { controller, send } = createController();
    const scopeless = makeTab("tab-scopeless", { scopeId: null });
    await expect(controller.requestAccess(scopeless.tab)).rejects.toThrow(
      "no workspace UI to request approval",
    );

    const handle = makeTab("tab-dead");
    handle.destroy();
    await expect(controller.requestAccess(handle.tab)).rejects.toThrow(
      "Browser tab is no longer available.",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("focuses an inactive tab, emits a request, lists it by scope, and promotes on approval", async () => {
    const { controller, send, activateTab, emitState } = createController();
    const handle = makeTab("tab-1", {
      url: "https://app.example.com/settings",
      title: "Settings",
      scopeId: 7,
      mode: "fresh",
      isActive: false,
    });

    const pending = controller.requestAccess(handle.tab, {
      targetUrl: "http://localhost:3000",
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    expect(activateTab).toHaveBeenCalledWith("tab-1");
    const [channel, request] = send.mock.calls[0] as [string, BrowserAgentAccessRequest];
    expect(channel).toBe("browser:agent-access-request");
    expect(request).toEqual({
      requestId: expect.any(String),
      tabId: "tab-1",
      scopeId: 7,
      origin: "https://app.example.com",
      url: "https://app.example.com/settings",
      title: "Settings",
      privacy: "private",
      targetUrl: "http://localhost:3000",
    });
    expect(controller.list(7)).toEqual([request]);
    expect(controller.list(8)).toEqual([]);

    controller.resolve(request.requestId, true);
    await expect(pending).resolves.toBeUndefined();

    expect(handle.tab.automationAccess).toBe("shared");
    expect(handle.tab.metadata.agentAccess).toBe("shared");
    expect(handle.tab.externalAutomationOrigin).toBe("https://app.example.com");
    expect(emitState).toHaveBeenCalledWith(7);
    expect(controller.list(7)).toEqual([]);
  });

  it("skips activateTab when the tab is already active and suspends focus guard while waiting", async () => {
    let suspended = false;
    let suspendCalls = 0;
    const suspendFocusGuard = async <T>(action: () => Promise<T>): Promise<T> => {
      suspendCalls += 1;
      suspended = true;
      try {
        return await action();
      } finally {
        suspended = false;
      }
    };
    const { controller, send, activateTab } = createController(120_000, suspendFocusGuard);
    const handle = makeTab("tab-active", { isActive: true });

    const pending = controller.requestAccess(handle.tab);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(activateTab).not.toHaveBeenCalled();
    expect(suspended).toBe(true);

    const request = send.mock.calls[0]?.[1] as BrowserAgentAccessRequest;
    controller.resolve(request.requestId, true);
    await expect(pending).resolves.toBeUndefined();
    expect(suspended).toBe(false);
    expect(suspendCalls).toBe(1);
  });

  it("maps persistent and feature profiles to normal and feature privacy", async () => {
    const { controller, send } = createController();
    const normal = makeTab("tab-normal", { mode: "persistent", url: "about:blank", title: "" });
    const feature = makeTab("tab-feature", { mode: "feature", url: "http://localhost:3000/" });

    const p1 = controller.requestAccess(normal.tab, { targetUrl: "http://localhost:3000/" });
    const p2 = controller.requestAccess(feature.tab);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    const r1 = send.mock.calls[0]?.[1] as BrowserAgentAccessRequest;
    const r2 = send.mock.calls[1]?.[1] as BrowserAgentAccessRequest;
    expect(r1.privacy).toBe("normal");
    expect(r1.origin).toBeNull();
    expect(r1.title).toBe("about:blank");
    expect(r2.privacy).toBe("feature");

    controller.resolve(r1.requestId, true);
    controller.resolve(r2.requestId, true);
    await Promise.all([p1, p2]);

    expect(normal.tab.externalAutomationOrigin).toBeNull();
    expect(feature.tab.externalAutomationOrigin).toBe("http://localhost:3000");
  });

  it("supports dormant tab approval without activating the tab", async () => {
    const { controller, send, activateTab, emitState } = createController();
    const dormant = {
      ...metadataFor("tab-dormant", "default", 7),
      url: "https://docs.example.com/guide",
      title: "Guide",
      suspended: true,
    };

    const pending = controller.requestDormantAccess(dormant);
    expect(activateTab).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "browser:agent-access-request",
      expect.objectContaining({
        tabId: "tab-dormant",
        scopeId: 7,
        origin: "https://docs.example.com",
        url: "https://docs.example.com/guide",
        title: "Guide",
        privacy: "normal",
      }),
    );

    const request = send.mock.calls[0]?.[1] as BrowserAgentAccessRequest;
    controller.resolve(request.requestId, true);
    await expect(pending).resolves.toBeUndefined();
    expect(activateTab).not.toHaveBeenCalled();
    expect(emitState).not.toHaveBeenCalled();
  });

  it("rejects waiters and emits cancellation when denied", async () => {
    const { controller, send, emitState } = createController();
    const handle = makeTab("tab-deny");

    const pending = controller.requestAccess(handle.tab);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const request = send.mock.calls[0]?.[1] as BrowserAgentAccessRequest;

    controller.resolve(request.requestId, false);
    await expect(pending).rejects.toThrow("The user denied agent access to this browser tab.");

    expect(handle.tab.automationAccess).toBe("user");
    expect(handle.tab.externalAutomationOrigin).toBeNull();
    expect(emitState).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith("browser:agent-access-request-cancelled", {
      requestId: request.requestId,
    });
  });

  it("emits cancellation when resolving an unknown request id so renderer clears stale banners", () => {
    const { controller, send } = createController();
    expect(() => controller.resolve("missing-deny", false)).not.toThrow();
    expect(send).toHaveBeenCalledWith("browser:agent-access-request-cancelled", {
      requestId: "missing-deny",
    });

    expect(() => controller.resolve("missing-allow", true)).toThrow(
      "This agent access request is no longer active.",
    );
    expect(send).toHaveBeenLastCalledWith("browser:agent-access-request-cancelled", {
      requestId: "missing-allow",
    });
  });

  it("enforces TOCTOU origin guard if the page changed before approval", async () => {
    const { controller, send } = createController();
    const handle = makeTab("tab-toctou", { url: "https://safe.example.com/" });

    const pending = controller.requestAccess(handle.tab);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const request = send.mock.calls[0]?.[1] as BrowserAgentAccessRequest;

    handle.setUrl("https://evil.example.com/");
    expect(() => controller.resolve(request.requestId, true)).toThrow(
      "The page changed before agent access was approved.",
    );
    await expect(pending).rejects.toThrow("The page changed before agent access was approved.");
    expect(handle.tab.automationAccess).toBe("user");
    expect(send).toHaveBeenLastCalledWith("browser:agent-access-request-cancelled", {
      requestId: request.requestId,
    });
  });

  it("cancels pending requests on main-frame navigation and tab close, and detaches listeners on destroy", async () => {
    const { controller, send } = createController();
    const handle = makeTab("tab-nav");
    controller.watch(handle.tab);
    expect(handle.emitter.listenerCount("did-start-navigation")).toBe(1);

    const pendingNav = controller.requestAccess(handle.tab);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const req1 = send.mock.calls[0]?.[1] as BrowserAgentAccessRequest;

    handle.emitter.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    handle.emitter.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(controller.list(7)).toEqual([req1]);

    handle.emitter.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    await expect(pendingNav).rejects.toThrow(
      "The browser tab navigated away before agent access was approved.",
    );
    expect(send).toHaveBeenLastCalledWith("browser:agent-access-request-cancelled", {
      requestId: req1.requestId,
    });

    const pendingClose = controller.requestAccess(handle.tab);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const req2 = send.mock.calls[2]?.[1] as BrowserAgentAccessRequest;

    handle.destroy();
    await expect(pendingClose).rejects.toThrow(
      "The browser tab was closed before agent access was approved.",
    );
    expect(handle.emitter.listenerCount("did-start-navigation")).toBe(0);
    expect(send).toHaveBeenLastCalledWith("browser:agent-access-request-cancelled", {
      requestId: req2.requestId,
    });
  });

  it("coalesces concurrent requests, skips duplicate activateTab, and upgrades targetUrl", async () => {
    const { controller, send, activateTab } = createController();
    const handle = makeTab("tab-coalesce", { isActive: false });

    const first = controller.requestAccess(handle.tab);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const second = controller.requestAccess(handle.tab, {
      targetUrl: "http://localhost:3000/",
    });

    expect(activateTab).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    const updated = send.mock.calls[1]?.[1] as BrowserAgentAccessRequest;
    expect(updated.targetUrl).toBe("http://localhost:3000/");

    controller.resolve(updated.requestId, true);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("cancels pending request only when all waiting callers abort", async () => {
    const { controller, send } = createController();
    const handle = makeTab("tab-abort", { isActive: true });
    const abort1 = new AbortController();
    const abort2 = new AbortController();

    const p1 = controller.requestAccess(handle.tab, { signal: abort1.signal });
    const p2 = controller.requestAccess(handle.tab, { signal: abort2.signal });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const request = send.mock.calls[0]?.[1] as BrowserAgentAccessRequest;

    abort1.abort();
    await expect(p1).rejects.toThrow("cancelled");
    expect(controller.list(7)).toEqual([request]);

    abort2.abort();
    await expect(p2).rejects.toThrow("cancelled");
    expect(controller.list(7)).toEqual([]);
    expect(send).toHaveBeenLastCalledWith("browser:agent-access-request-cancelled", {
      requestId: request.requestId,
    });
  });

  it("settles pending requests immediately when sharing changes via Site Info", async () => {
    const { controller, send } = createController();
    const handle = makeTab("tab-site-sync", { isActive: true });

    const pendingAllow = controller.requestAccess(handle.tab);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const req1 = send.mock.calls[0]?.[1] as BrowserAgentAccessRequest;

    controller.syncExternalAccessChange("tab-site-sync", true);
    await expect(pendingAllow).resolves.toBeUndefined();
    expect(send).toHaveBeenLastCalledWith("browser:agent-access-request-cancelled", {
      requestId: req1.requestId,
    });

    const pendingDeny = controller.requestAccess(handle.tab);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    const req2 = send.mock.calls[2]?.[1] as BrowserAgentAccessRequest;

    controller.syncExternalAccessChange("tab-site-sync", false);
    await expect(pendingDeny).rejects.toThrow("The user denied agent access");
    expect(send).toHaveBeenLastCalledWith("browser:agent-access-request-cancelled", {
      requestId: req2.requestId,
    });
  });

  it("times out pending requests and emits cancellation", async () => {
    vi.useFakeTimers();
    const { controller, send } = createController(5_000);
    const handle = makeTab("tab-timeout");

    const pending = controller.requestAccess(handle.tab);
    const rejection = expect(pending).rejects.toThrow(
      "Timed out waiting for user approval to access this browser tab.",
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const request = send.mock.calls[0]?.[1] as BrowserAgentAccessRequest;

    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(send).toHaveBeenLastCalledWith("browser:agent-access-request-cancelled", {
      requestId: request.requestId,
    });
    expect(controller.list(7)).toEqual([]);
  });

  it("cancels all pending requests cleanly on cancelAll", async () => {
    const { controller, send } = createController();
    const first = makeTab("tab-a", { scopeId: 1 });
    const second = makeTab("tab-b", { scopeId: 2 });

    const p1 = controller.requestAccess(first.tab);
    const p2 = controller.requestAccess(second.tab);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    controller.cancelAll();
    await expect(p1).rejects.toThrow("closed before agent access was approved");
    await expect(p2).rejects.toThrow("closed before agent access was approved");
    expect(controller.list(1)).toEqual([]);
    expect(controller.list(2)).toEqual([]);
  });
});
