import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDiagnosticRecords, saveDiagnosticRecord } from "./renderer-diagnostics-store";
import type { DiagnosticRecord } from "../../src/shared/renderer-diagnostics";

function record(platform: string, index: number): DiagnosticRecord {
  return {
    timestamp: new Date(index).toISOString(),
    appVersion: "0.15.0",
    platform,
    arch: "x64",
    electron: "42",
    chrome: "148",
    error: { source: "error", message: `error ${index}` },
  };
}

describe.each(["darwin", "linux"])("diagnostic persistence on %s", (platform) => {
  it("retains the latest ten crashes across restarts and never imposes a lifetime cap", () => {
    const file = path.join(
      mkdtempSync(path.join(os.tmpdir(), "cadencr-diag-")),
      "logs/history.json",
    );
    for (let i = 0; i < 120; i++) saveDiagnosticRecord(file, record(platform, i));
    const reloaded = readDiagnosticRecords(file);
    expect(reloaded).toHaveLength(10);
    expect(reloaded[0].error.message).toBe("error 110");
    expect(reloaded[9]).toEqual(record(platform, 119));
    expect(readFileSync(file, "utf8").length).toBeLessThan(5000);
  });

  it("protects fatal reports from a later burst of recoverable React errors", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "cadencr-diag-")), "history.json");
    saveDiagnosticRecord(file, record(platform, 0));
    for (let i = 1; i < 30; i++) {
      const next = record(platform, i);
      next.error.source = "react-recoverable";
      saveDiagnosticRecord(file, next);
    }
    expect(readDiagnosticRecords(file)[0].error.message).toBe("error 0");
  });

  it("surfaces corrupt history without silently overwriting it", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "cadencr-diag-")), "history.json");
    writeFileSync(file, "corrupt evidence");
    expect(() => saveDiagnosticRecord(file, record(platform, 0))).toThrow();
    expect(readFileSync(file, "utf8")).toBe("corrupt evidence");
  });

  it.each([
    "ResizeObserver loop completed with undelivered notifications",
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop limit exceeded",
    "ResizeObserver loop limit exceeded.",
  ])("re-reads fatal evidence from disk after a burst of %s", (message) => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "cadencr-diag-")), "history.json");
    const fatal = record(platform, 0);
    fatal.error = { source: "react-uncaught", message: "fatal", componentStack: "at AgentPanel" };
    saveDiagnosticRecord(file, fatal);
    for (let i = 1; i <= 30; i++) {
      const noise = record(platform, i);
      noise.error.message = message;
      saveDiagnosticRecord(file, noise);
    }
    const reloaded = readDiagnosticRecords(file);
    expect(reloaded).toHaveLength(10);
    expect(reloaded[0]).toEqual(fatal);
    expect(reloaded.slice(1).map((item) => item.timestamp)).toEqual(
      Array.from({ length: 9 }, (_, i) => record(platform, i + 22).timestamp),
    );
  });
});
