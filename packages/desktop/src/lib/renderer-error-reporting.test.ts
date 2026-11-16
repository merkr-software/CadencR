// @vitest-environment jsdom
// Pinned to jsdom: happy-dom has no PromiseRejectionEvent.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installGlobalRendererErrorHandlers,
  createReactErrorReporter,
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

describe("createReactErrorReporter", () => {
  it("reuses the persisted crash context during repeat suppression and renews it afterwards", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const report = vi.fn(() => Promise.resolve());
    const reportReactError = createReactErrorReporter(report);
    const error = new Error("same crash");
    const first = reportReactError(error, "at Panel");
    await Promise.resolve();
    const repeated = reportReactError(error, "at Panel");
    await Promise.resolve();
    expect(repeated).toBe(first);
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ diagnostics: first }));
    now += 10_001;
    const later = reportReactError(error, "at Panel");
    await Promise.resolve();
    expect(later.reportId).not.toBe(first.reportId);
    expect(report).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("deduplicates loops, retains fuller stacks and accepts a distinct fatal error", async () => {
    const report = vi.fn(() => Promise.resolve());
    const reportReactError = createReactErrorReporter(report);
    for (let i = 0; i < 19; i += 1) reportReactError(new Error("earlier"), "at Panel");
    const error = new Error("last error");
    reportReactError(error, null);
    reportReactError(error, "at StreamingPanel");
    reportReactError(error, "at StreamingPanel\n at App");
    reportReactError(error, null);
    reportReactError(new Error("over limit"), "at OtherPanel", "react-uncaught");
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "last error",
        componentStack: "at StreamingPanel\n at App",
      }),
    );
  });

  it("does not replace an existing component stack with an empty duplicate", async () => {
    const report = vi.fn(() => Promise.resolve());
    const reportReactError = createReactErrorReporter(report);
    const error = new Error("failed");
    reportReactError(error, "at Panel");
    reportReactError(error, "");
    reportReactError(error, "at Panel");
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
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

  it("keeps new distinct global errors beyond the old lifetime cap", () => {
    const report = vi.fn<(_payload: ReturnType<typeof toRendererErrorPayload>) => Promise<void>>(
      () => Promise.resolve(),
    );

    const uninstall = installGlobalRendererErrorHandlers(report);
    for (let i = 0; i < 25; i += 1) {
      window.dispatchEvent(new ErrorEvent("error", { message: `global boom ${i}` }));
    }

    expect(report).toHaveBeenCalledTimes(25);
    uninstall();
  });
});
