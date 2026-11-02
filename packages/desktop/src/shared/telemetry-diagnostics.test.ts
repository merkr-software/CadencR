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
