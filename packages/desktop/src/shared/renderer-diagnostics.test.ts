import { describe, expect, it } from "vitest";
import { retainDiagnosticRecord, type DiagnosticRecord } from "./renderer-diagnostics";

function record(
  id: number,
  source: DiagnosticRecord["error"]["source"] = "react-uncaught",
  message = `report ${id}`,
): DiagnosticRecord {
  return {
    timestamp: new Date(id).toISOString(),
    appVersion: "0.15.1",
    platform: "browser",
    arch: "unknown",
    electron: "none",
    chrome: "unknown",
    error: { source, message },
  };
}

const noiseMessages = [
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop limit exceeded.",
];

describe("diagnostic retention", () => {
  it.each(noiseMessages)("preserves fatal evidence through a burst of %s", (message) => {
    const fatal = [record(0), record(1, "react-boundary")];
    let retained = fatal;
    for (let id = 2; id < 40; id++) {
      retained = retainDiagnosticRecord(retained, record(id, "error", message));
      expect(retained.length).toBeLessThanOrEqual(10);
    }
    expect(retained).toEqual([
      ...fatal,
      ...Array.from({ length: 8 }, (_, i) => record(i + 32, "error", message)),
    ]);
  });

  it.each(noiseMessages)("evicts incoming noise from an entirely fatal buffer: %s", (message) => {
    const fatal = Array.from({ length: 10 }, (_, i) => record(i));
    expect(retainDiagnosticRecord(fatal, record(10, "error", message))).toEqual(fatal);
    expect(fatal).toHaveLength(10);
  });

  it("evicts noise, then recoverable reports, then the oldest important report, preserving order", () => {
    const fatal = Array.from({ length: 8 }, (_, i) => record(i));
    const recoverable = record(8, "react-recoverable");
    const noise = record(9, "error", noiseMessages[0]);
    const original = [...fatal, recoverable, noise];
    const afterNoise = retainDiagnosticRecord(original, record(10));
    expect(afterNoise).toEqual([...fatal, recoverable, record(10)]);
    const afterRecovery = retainDiagnosticRecord(afterNoise, record(11));
    expect(afterRecovery).toEqual([...fatal, record(10), record(11)]);
    expect(retainDiagnosticRecord(afterRecovery, record(12))).toEqual([
      ...fatal.slice(1),
      record(10),
      record(11),
      record(12),
    ]);
    expect(original).toEqual([...fatal, recoverable, noise]);
  });

  it("keeps recoverable evidence ahead of even newly arriving noise", () => {
    const important = Array.from({ length: 9 }, (_, i) => record(i));
    const retained = [...important, record(9, "react-recoverable")];
    expect(retainDiagnosticRecord(retained, record(10, "error", noiseMessages[0]))).toEqual(
      retained,
    );
    expect(retainDiagnosticRecord(important, record(9, "error", noiseMessages[0]))).toHaveLength(
      10,
    );
  });

  it.each([
    ["error", "TypeError: Cannot read properties of undefined"],
    ["error", "ResizeObserver failed to observe target"],
    ["error", "ResizeObserver loop completed with undelivered notifications: unexpected failure"],
    ["error", "Prefix ResizeObserver loop limit exceeded"],
    ["error", "ResizeObserver loop limit exceeded\nreal error"],
    ["error", "ResizeObserver loop limit exceeded\n"],
    ["unhandledrejection", noiseMessages[0]],
    ["react-uncaught", noiseMessages[0]],
    ["react-boundary", noiseMessages[0]],
  ] as const)("preserves other %s errors: %s", (source, message) => {
    const important = record(0, source, message);
    let retained = [important];
    for (let i = 1; i < 25; i++) {
      retained = retainDiagnosticRecord(retained, record(i, "error", noiseMessages[0]));
    }
    expect(retained[0]).toEqual(important);
  });

  it("keeps the newest ten ordinary errors and rejections without changing their payloads", () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      record(i, i % 2 === 0 ? "error" : "unhandledrejection"),
    );
    expect(records.reduce(retainDiagnosticRecord, [] as DiagnosticRecord[])).toEqual(
      records.slice(-10),
    );
  });
});
