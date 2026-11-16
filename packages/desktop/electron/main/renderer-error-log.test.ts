import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendRendererErrorLog } from "./renderer-error-log";

describe("appendRendererErrorLog", () => {
  it.each(["react-boundary", "react-uncaught", "react-recoverable"])(
    "preserves %s component stacks on macOS and Linux",
    (source) => {
      for (const platform of ["darwin", "linux"]) {
        const dir = mkdtempSync(path.join(tmpdir(), "cadencr-react-log-test-"));
        const logPath = path.join(dir, "renderer-errors.log");
        appendRendererErrorLog(
          { source, message: "React failed", componentStack: "\n    at StreamingPanel" },
          { appVersion: "0.15.0", logPath, now: () => new Date(0), platform },
        );
        const log = readFileSync(logPath, "utf8");
        expect(log).toContain(`source: ${source}`);
        expect(log).toContain(`platform: ${platform}`);
        expect(log).toContain("componentStack:\n\n    at StreamingPanel");
      }
    },
  );

  it("persists sanitized renderer error diagnostics", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cadencr-renderer-error-test-"));
    const logPath = path.join(dir, "renderer-errors.log");

    appendRendererErrorLog(
      {
        source: "unhandledrejection",
        message: "Maximum update depth exceeded",
        stack: "Error: Maximum update depth exceeded\n    at AgentCard",
        componentStack: "\n    at AgentCard",
        url: "file:///Applications/Cadencr.app/index.html",
        line: 12,
        column: 34,
      },
      {
        appVersion: "0.6.1",
        logPath,
        now: () => new Date("2026-06-22T19:15:00.000Z"),
        platform: "darwin",
      },
    );

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("Cadencr renderer error");
    expect(log).toContain("source: unhandledrejection");
    expect(log).toContain("message: Maximum update depth exceeded");
    expect(log).toContain("componentStack:");
    expect(log).toContain("at AgentCard");
  });

  it("rejects malformed payloads instead of logging arbitrary data", () => {
    expect(() =>
      appendRendererErrorLog(
        { source: "error", message: 123 },
        {
          appVersion: "0.6.1",
          logPath: "/tmp/unused-renderer-errors.log",
          now: () => new Date("2026-06-22T19:15:00.000Z"),
          platform: "darwin",
        },
      ),
    ).toThrow(/message/);
  });

  it("rejects malformed source positions", () => {
    expect(() =>
      appendRendererErrorLog(
        { source: "error", message: "boom", line: Number.NaN },
        {
          appVersion: "0.6.1",
          logPath: "/tmp/unused-renderer-errors.log",
          now: () => new Date("2026-06-22T19:15:00.000Z"),
          platform: "darwin",
        },
      ),
    ).toThrow(/line/);
  });
});
