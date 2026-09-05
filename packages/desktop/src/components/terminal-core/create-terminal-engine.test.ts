import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalOptions } from "celeritty";
import { createTerminalEngine } from "./create-terminal-engine";
const mocks = vi.hoisted(() => ({
  primary: { ready: Promise.resolve(), dispose: vi.fn() },
  fallback: { ready: Promise.resolve(), dispose: vi.fn() },
  primaryCount: 0,
  fallbackCount: 0,
  warning: vi.fn(),
}));
vi.mock("celeritty", () => ({
  createWebGpuRenderer: vi.fn(),
  Terminal: class {
    constructor() {
      mocks.primaryCount++;
      return mocks.primary;
    }
  },
}));
vi.mock("./xterm-compatibility", () => ({
  XtermCompatibility: class {
    constructor() {
      mocks.fallbackCount++;
      return mocks.fallback;
    }
  },
}));
vi.mock("sonner", () => ({ toast: { warning: mocks.warning } }));
const options = {} as TerminalOptions;
beforeEach(() => {
  mocks.primaryCount = 0;
  mocks.fallbackCount = 0;
  mocks.primary.ready = Promise.resolve();
  mocks.fallback.ready = Promise.resolve();
  vi.clearAllMocks();
});
describe("terminal engine selection", () => {
  it("uses CeleriTTY without constructing the compatibility engine on success", async () => {
    const host = document.createElement("div");
    const lifetime = createTerminalEngine(host, options);
    expect(await lifetime.ready).toBe(mocks.primary);
    expect(host.dataset.terminalRenderer).toBe("celeritty");
    expect(mocks.fallbackCount).toBe(0);
    lifetime.dispose();
    lifetime.dispose();
    expect(mocks.primary.dispose).toHaveBeenCalledTimes(1);
  });
  it("keeps the terminal usable after a GPU failure and visibly reports fallback", async () => {
    const host = document.createElement("div");
    mocks.primary.ready = Promise.reject(new Error("No WebGPU adapter"));
    const lifetime = createTerminalEngine(host, options);
    expect(await lifetime.ready).toBe(mocks.fallback);
    expect(host.dataset.terminalRenderer).toBe("xterm");
    expect(mocks.primary.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.warning).toHaveBeenCalledWith(
      "Using the compatibility terminal",
      expect.objectContaining({ description: "No WebGPU adapter" }),
    );
    lifetime.dispose();
    expect(mocks.fallback.dispose).toHaveBeenCalledTimes(1);
  });
  it("does not create a fallback or report an error after unmount", async () => {
    let reject!: (reason: Error) => void;
    mocks.primary.ready = new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const lifetime = createTerminalEngine(document.createElement("div"), options);
    lifetime.dispose();
    reject(new Error("initialization cancelled"));
    expect(await lifetime.ready).toBeUndefined();
    expect(mocks.fallbackCount).toBe(0);
    expect(mocks.warning).not.toHaveBeenCalled();
  });
  it("propagates compatibility initialization failures for the visible error state", async () => {
    mocks.primary.ready = Promise.reject(new Error("GPU failed"));
    const lifetime = createTerminalEngine(document.createElement("div"), options);
    // Install rejection just before fallback construction without an unhandled promise.
    let reject!: (error: Error) => void;
    mocks.fallback.ready = new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const assertion = expect(lifetime.ready).rejects.toThrow("fallback failed");
    await vi.waitFor(() => expect(mocks.fallbackCount).toBe(1));
    reject(new Error("fallback failed"));
    await assertion;
    lifetime.dispose();
    expect(mocks.fallback.dispose).toHaveBeenCalledTimes(1);
  });
});
