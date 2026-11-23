import { EventEmitter } from "node:events";
import type { HandlerDetails, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { BrowserPopupController } from "./browser-popup-controller";
import type { ManagedTab } from "./browser-tab-events";

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn() },
}));

function popupDetails(overrides: Partial<HandlerDetails> = {}): HandlerDetails {
  return {
    url: "https://login.example.com/",
    frameName: "_blank",
    features: "",
    disposition: "foreground-tab",
    referrer: { url: "", policy: "default" },
    ...overrides,
  } as HandlerDetails;
}

function setup() {
  const contents = Object.assign(new EventEmitter(), {
    getURL: vi.fn(() => "https://example.com/"),
    setWindowOpenHandler: vi.fn(),
  });
  const tab = {
    metadata: { id: "tab-1", scopeId: 1 },
    profile: { id: "default", label: "Default", mode: "persistent" },
    webContents: contents,
    popupGestureAt: null,
    syntheticPopupMouseEvents: 0,
    syntheticPopupKeyEvents: 0,
    syntheticPopupInputExpiresAt: 0,
  } as unknown as ManagedTab;
  const host = {
    getWindow: () => null,
    currentUrl: () => "https://example.com/",
    assertCanCreateNative: vi.fn(),
    createNativeChild: vi.fn(() => ({}) as WebContents),
    reportError: vi.fn(),
  };
  const controller = new BrowserPopupController(host);
  controller.watch(tab);
  const handler = contents.setWindowOpenHandler.mock.calls[0][0] as (
    details: HandlerDetails,
  ) => Electron.WindowOpenHandlerResponse;
  return { contents, tab, host, controller, handler };
}

describe("BrowserPopupController", () => {
  it("denies invalid or non-navigable popup URLs quietly without reporting a scope error", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const { host, handler } = setup();
      for (const url of [
        "javascript:void(0)",
        "mailto:user@example.com",
        "file:///etc/passwd",
        "https://user:pass@example.com/",
        "not-a-valid-url",
      ]) {
        expect(handler(popupDetails({ url }))).toEqual({ action: "deny" });
      }
      expect(host.reportError).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledTimes(5);
    } finally {
      debug.mockRestore();
    }
  });

  it("still reports an error when creating a native popup exceeds limits", () => {
    const { contents, host, handler } = setup();
    host.assertCanCreateNative.mockImplementation(() => {
      throw new Error("Tab limit reached");
    });
    contents.emit("before-mouse-event", {}, { type: "mouseDown", button: "left" });
    expect(handler(popupDetails({ url: "https://login.example.com/" }))).toEqual({
      action: "deny",
    });
    expect(host.reportError).toHaveBeenCalledOnce();
  });
});
