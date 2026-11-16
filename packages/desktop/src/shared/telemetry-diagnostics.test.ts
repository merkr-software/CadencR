import { describe, expect, it } from "vitest";
import {
  mainRemoteDiagnostic,
  rendererRemoteDiagnostic,
  remoteDiagnosticFrames,
} from "./telemetry-diagnostics";

const assets = new Set(["index-AbCd1234.js", "ui-XyZ12345.js"]);
describe("remote diagnostic privacy boundary", () => {
  it("sends only a category and exact shipped asset locations", () => {
    const result = rendererRemoteDiagnostic(
      {
        source: "react-boundary",
        message: "secret prompt sk-token",
        componentStack: "user /home/alice/project",
        stack:
          "Error: private source text\n at secretFunction (file:///Users/alice/repo/out/renderer/assets/index-AbCd1234.js:12:34)\n at secret (https://private.company/user.js:4:5)\n at file:///tmp/secret.js:1:2",
      },
      assets,
    );
    expect(result).toEqual({
      category: "react_boundary",
      frames: [{ filename: "assets/index-AbCd1234.js", lineno: 12, colno: 34 }],
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|alice|private|file:|https:/);
  });
  it("normalizes macOS and Linux paths and reverses frame order for Sentry", () => {
    expect(
      remoteDiagnosticFrames(
        "Error\n at /Users/u/app/assets/index-AbCd1234.js:1:2\n at /home/u/app/assets/ui-XyZ12345.js:3:4",
        assets,
      ),
    ).toEqual([
      { filename: "assets/ui-XyZ12345.js", lineno: 3, colno: 4 },
      { filename: "assets/index-AbCd1234.js", lineno: 1, colno: 2 },
    ]);
  });
  it("rejects unknown assets, query strings, unsafe numbers and text-only stacks", () => {
    expect(
      remoteDiagnosticFrames(
        "Error\n at /assets/secret.js:1:2\n at /assets/index-AbCd1234.js?token=secret:1:2\n at /assets/index-AbCd1234.js:90071992547409999:1\n at /assets/index-AbCd1234.js:0:2",
        assets,
      ),
    ).toEqual([]);
  });
  it("projects main errors without messages, names or machine paths", () => {
    const error = new Error("private prompt");
    error.stack =
      "Error: private\n at secret (/Users/alice/app/out/main/index.js:44:55)\n at /home/u/repo/secret.js:1:2";
    expect(mainRemoteDiagnostic(error)).toEqual({
      category: "electron_main",
      frames: [{ filename: "main/index.js", lineno: 44, colno: 55 }],
    });
  });
});

it("retains only the safe build identifier needed for source maps", () => {
  const diagnostics = { buildId: "abc123-linux-uuid" } as Parameters<
    typeof rendererRemoteDiagnostic
  >[0]["diagnostics"];
  expect(
    rendererRemoteDiagnostic({ source: "error", message: "secret", diagnostics }, assets),
  ).toEqual({ category: "renderer_unhandled_error", frames: [], build_id: "abc123-linux-uuid" });
  expect(
    rendererRemoteDiagnostic(
      {
        source: "error",
        message: "secret",
        diagnostics: { ...diagnostics!, buildId: "https://secret/path?token=private" },
      },
      assets,
    ),
  ).not.toHaveProperty("build_id");
});

it.each([
  "file:///Applications/Cadencr.app/Contents/Resources/renderer/assets/index-AbCd1234.js",
  "file:///tmp/.mount_Cadencr/resources/renderer/assets/index-AbCd1234.js",
])("recovers a stackless ErrorEvent location from %s", (url) => {
  const report = rendererRemoteDiagnostic(
    {
      source: "error",
      message: "private prompt",
      stack: null,
      url,
      line: 12,
      column: 34,
    },
    assets,
  );
  expect(report).toEqual({
    category: "renderer_unhandled_error",
    frames: [{ filename: "assets/index-AbCd1234.js", lineno: 12, colno: 34 }],
  });
  expect(JSON.stringify(report)).not.toMatch(/private|Applications|mount|file:/);
});

it("keeps the original stack rather than appending the event fallback", () => {
  expect(
    rendererRemoteDiagnostic(
      {
        source: "error",
        message: "secret",
        stack: "    at file:///app/assets/ui-XyZ12345.js:3:4",
        url: "file:///app/assets/index-AbCd1234.js",
        line: 5,
        column: 6,
      },
      assets,
    )?.frames,
  ).toEqual([{ filename: "assets/ui-XyZ12345.js", lineno: 3, colno: 4 }]);
});

it.each([
  "https://private.example/assets/index-AbCd1234.js",
  "file:///app/assets/index-AbCd1234.js?token=secret",
  "file:///app/assets/index-AbCd1234.js#secret",
  "file:///home/user/project/private.js",
  "file:///app/index.html",
])("rejects unsafe or non-bundle fallback locations: %s", (url) => {
  expect(
    rendererRemoteDiagnostic(
      { source: "error", message: "secret", url, line: 1, column: 2 },
      assets,
    )?.frames,
  ).toEqual([]);
});

it("never fabricates frames for locationless errors, rejections or untrusted builds", () => {
  const event = {
    source: "error" as const,
    message: "Script error.",
    url: "file:///app/assets/index-AbCd1234.js",
    line: 1,
    column: 2,
  };
  expect(rendererRemoteDiagnostic(event, new Set())?.frames).toEqual([]);
  expect(rendererRemoteDiagnostic({ ...event, line: null, column: null }, assets)?.frames).toEqual(
    [],
  );
  expect(
    rendererRemoteDiagnostic({ ...event, source: "unhandledrejection" }, assets)?.frames,
  ).toEqual([]);
});

it.each([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
])("keeps locationless ResizeObserver noise out of remote diagnostics: %s", (message) => {
  const url = "file:///app/index.html";
  expect(rendererRemoteDiagnostic({ source: "error", message, url }, assets)).toBeNull();
  expect(rendererRemoteDiagnostic({ source: "unhandledrejection", message, url }, assets)).toEqual({
    category: "renderer_unhandled_rejection",
    frames: [],
  });
});

it("bounds positions and frames before transport without discarding valid neighbors", () => {
  const invalid = [0, -1, 1.5, NaN, Infinity, 10_000_001];
  for (const position of invalid) {
    for (const [line, column] of [
      [position, 1],
      [1, position],
    ]) {
      expect(
        rendererRemoteDiagnostic(
          {
            source: "error",
            message: "secret",
            url: "file:///app/assets/index-AbCd1234.js",
            line,
            column,
          },
          assets,
        )?.frames,
      ).toEqual([]);
    }
  }
  expect(
    remoteDiagnosticFrames(
      "Error\n at /app/assets/index-AbCd1234.js:10000001:2\n at /app/assets/ui-XyZ12345.js:3:4",
      assets,
    ),
  ).toEqual([{ filename: "assets/ui-XyZ12345.js", lineno: 3, colno: 4 }]);
  expect(
    remoteDiagnosticFrames(
      "Error\n" + " at /app/assets/index-AbCd1234.js:1:2\n".repeat(100),
      assets,
    ),
  ).toHaveLength(30);
  expect(
    remoteDiagnosticFrames(
      "Error\n at secret (https://example.org/assets/index-AbCd1234.js:1:2)\n at eval (eval at secret (/app/assets/index-AbCd1234.js:1:2))",
      assets,
    ),
  ).toEqual([]);
});
