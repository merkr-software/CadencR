import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { normalizeRendererError } from "./renderer-error";
import { rendererRemoteDiagnostic } from "./telemetry-diagnostics";

it.each(["new Error()", "new TypeError()"])(
  "retains the original foreign realm stack without an own message: %s",
  (expression) => {
    const error: unknown = runInNewContext(expression);
    expect(Object.getOwnPropertyDescriptor(error, "message")).toBeUndefined();
    const normalized = normalizeRendererError(error);
    expect(normalized.message).toBe("");
    expect(normalized.stack).toContain("evalmachine.<anonymous>:1:");
  },
);

// Run under Electron's Node runtime as well as Node 22 to exercise Chromium's accessor.
it.runIf(!!Object.getOwnPropertyDescriptor(new Error(), "stack")?.get)(
  "reads a branded foreign Error's native stack without invoking its replacement getter",
  () => {
    const error: unknown = runInNewContext('new Error("native error")');
    expect(Object.getOwnPropertyDescriptor(error, "stack")?.get).toBeTypeOf("function");
    const get = vi.fn(() => "arbitrary payload");
    Object.defineProperty(error, "stack", { get });
    const normalized = normalizeRendererError(error);
    expect(normalized.message).toBe("native error");
    expect(normalized.stack).toContain("evalmachine.<anonymous>:1:");
    expect(normalized.stack).not.toContain("arbitrary payload");
    expect(get).not.toHaveBeenCalled();
  },
);

it("preserves a foreign realm Error stack through normalization and safe projection", () => {
  const error: unknown = runInNewContext('new Error("private prompt")');
  expect(error).not.toBeInstanceOf(Error);
  Object.defineProperty(error, "stack", {
    value: "Error: private prompt\n at secret (file:///home/private/app/assets/index-test.js:4:9)",
  });
  const normalized = normalizeRendererError(error);
  expect(normalized.stack).toContain("index-test.js:4:9");
  expect(
    rendererRemoteDiagnostic({ source: "error", ...normalized }, new Set(["index-test.js"])),
  ).toEqual({
    category: "renderer_unhandled_error",
    frames: [{ filename: "assets/index-test.js", lineno: 4, colno: 9 }],
  });
});

it("does not execute stack getters or coerce arbitrary stack payloads", () => {
  const get = vi.fn(() => "secret");
  const error = Object.defineProperty({ message: "local message" }, "stack", { get });
  expect(normalizeRendererError(error)).toEqual({ message: "local message", stack: null });
  expect(get).not.toHaveBeenCalled();
  expect(
    normalizeRendererError({ message: "local", stack: { prompt: "secret" } }).stack,
  ).toBeNull();
});
