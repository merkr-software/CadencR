// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDeviceTokenMemoryForTests,
  clearDeviceToken,
  isBrowserRemote,
  isHiddenBrowserRemote,
  readDeviceToken,
  writeDeviceToken,
} from "./device-token";

const KEY = "cadencr.remoteDeviceToken";

describe("isBrowserRemote", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "cadencr");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is true over https with no preload bridge", () => {
    vi.stubGlobal("location", { protocol: "https:" });
    expect(isBrowserRemote()).toBe(true);
  });

  it("is false when the Electron preload bridge is present", () => {
    vi.stubGlobal("location", { protocol: "https:" });
    Object.assign(window, { cadencr: {} });
    expect(isBrowserRemote()).toBe(false);
  });

  it("is false over http (dev / loopback)", () => {
    vi.stubGlobal("location", { protocol: "http:" });
    expect(isBrowserRemote()).toBe(false);
  });

  it("identifies a hidden remote browser", () => {
    vi.stubGlobal("location", { protocol: "https:" });
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    expect(isHiddenBrowserRemote()).toBe(true);
  });

  it("does not treat a visible remote browser as hidden", () => {
    vi.stubGlobal("location", { protocol: "https:" });
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    expect(isHiddenBrowserRemote()).toBe(false);
  });
});

describe("device-token storage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetDeviceTokenMemoryForTests();
  });

  it("defaults to sessionStorage and reads back", () => {
    expect(writeDeviceToken("tok", false)).toBe(true);
    expect(sessionStorage.getItem(KEY)).toBe("tok");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readDeviceToken()).toBe("tok");
  });

  it("treats the in-memory token as authoritative over storage", () => {
    writeDeviceToken("fresh", false);
    // A stale persisted value must not override the live in-memory one — this
    // is what lets a 401-driven clear / re-pair take effect without a reload.
    sessionStorage.setItem(KEY, "stale");
    expect(readDeviceToken()).toBe("fresh");
  });

  it("promotes to localStorage with trust and clears the session copy", () => {
    writeDeviceToken("session-tok", false);
    writeDeviceToken("trusted-tok", true);
    expect(localStorage.getItem(KEY)).toBe("trusted-tok");
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(readDeviceToken()).toBe("trusted-tok");
  });

  it("clearDeviceToken removes the token from both stores", () => {
    writeDeviceToken("tok", true);
    clearDeviceToken();
    expect(readDeviceToken()).toBeNull();
  });
});
