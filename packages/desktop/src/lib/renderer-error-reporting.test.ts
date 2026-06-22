import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installGlobalRendererErrorHandlers,
  toRendererErrorPayload,
} from "./renderer-error-reporting";

describe("toRendererErrorPayload", () => {
  it("normalizes ErrorEvent data", () => {
    const payload = toRendererErrorPayload(
      new ErrorEvent("error", {
        message: "boom",
        error: new Error("boom"),
        filename: "file:///app/index.js",
        lineno: 4,
        colno: 9,
      }),
    );

    expect(payload).toMatchObject({
      source: "error",
      message: "boom",
      url: "file:///app/index.js",
      line: 4,
      column: 9,
    });
    expect(payload.stack).toContain("boom");
  });

  it("normalizes unhandled promise rejections", () => {
    const payload = toRendererErrorPayload(
      new PromiseRejectionEvent("unhandledrejection", {
        promise: Promise.reject(new Error("async failed")).catch(() => undefined),
        reason: new Error("async failed"),
      }),
    );

    expect(payload.source).toBe("unhandledrejection");
    expect(payload.message).toBe("async failed");
    expect(payload.stack).toContain("async failed");
  });
});

describe("installGlobalRendererErrorHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports global errors and uninstalls listeners", () => {
    const report = vi.fn<(_payload: ReturnType<typeof toRendererErrorPayload>) => Promise<void>>(
      () => Promise.resolve(),
    );

    const uninstall = installGlobalRendererErrorHandlers(report);
    window.dispatchEvent(new ErrorEvent("error", { message: "global boom" }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "global boom" }));

    uninstall();
    window.dispatchEvent(new ErrorEvent("error", { message: "after uninstall" }));
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("caps global error reports from repeated error loops", () => {
    const report = vi.fn<(_payload: ReturnType<typeof toRendererErrorPayload>) => Promise<void>>(
      () => Promise.resolve(),
    );

    const uninstall = installGlobalRendererErrorHandlers(report);
    for (let i = 0; i < 25; i += 1) {
      window.dispatchEvent(new ErrorEvent("error", { message: `global boom ${i}` }));
    }

    expect(report).toHaveBeenCalledTimes(20);
    uninstall();
  });
});
