// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureDiagnosticContext,
  createDiagnosticHistory,
  diagnosticRoute,
  installDiagnosticBrowserEvents,
} from "./renderer-diagnostics";
import { createDiagnosticGate, diagnosticContextSchema } from "@/shared/renderer-diagnostics";
import { persistBrowserDiagnostic } from "./renderer-diagnostics-browser";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("diagnostic history", () => {
  it("bounds history, aggregates interleaved stream bursts and freezes crash snapshots", () => {
    let now = 1000;
    const history = createDiagnosticHistory(() => now);
    history.record("navigation", { route: "/agents" });
    for (let i = 0; i < 1000; i++) {
      history.record("stream", { action: "text.delta" });
      history.record("stream", { action: "tool.delta" });
    }
    const crash = history.snapshot();
    expect(crash.map((item) => item.count)).toEqual([1, 1000, 1000]);
    history.record("stream", { action: "text.delta" });
    expect(crash[1].count).toBe(1000);
    for (let i = 0; i < 150; i++) {
      now += 1000;
      history.record("viewport", { width: i });
    }
    expect(history.snapshot().length).toBeLessThanOrEqual(61);
    now += 60_001;
    expect(history.snapshot()).toEqual([]);
  });

  it("does not collect route secrets, button text or input values", () => {
    expect(diagnosticRoute("#/projects/12/features/43?token=secret#private")).toBe(
      "/projects/:id/features/:id",
    );
    const stop = installDiagnosticBrowserEvents();
    const button = document.createElement("button");
    button.textContent = "private conversation";
    button.setAttribute("title", "secret");
    document.body.append(button);
    button.click();
    const snapshot = captureDiagnosticContext();
    expect(diagnosticContextSchema.safeParse(snapshot).success).toBe(true);
    expect(JSON.stringify(snapshot.breadcrumbs)).not.toMatch(/secret|private conversation/);
    stop();
    button.remove();
  });

  it("keeps a new fatal error after hundreds of errors and reopens repeat collection after ten seconds", () => {
    let now = 0;
    const gate = createDiagnosticGate(() => now);
    const error = { source: "error" as const, message: "noise" };
    expect(gate.accept(error)).toBe(true);
    for (let i = 0; i < 200; i++) expect(gate.accept(error)).toBe(false);
    expect(gate.suppressed()).toBe(200);
    expect(
      gate.accept({ source: "react-uncaught", message: "Maximum update depth exceeded" }),
    ).toBe(true);
    now = 10_001;
    expect(gate.accept(error)).toBe(true);
    for (let i = 0; i < 200; i++)
      expect(gate.accept({ ...error, message: `distinct ${i}` })).toBe(true);
  });
});

it.each([
  "ResizeObserver loop completed with undelivered notifications",
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop limit exceeded.",
])("exports the original browser crash context after noise and reload: %s", async (message) => {
  const diagnostics = captureDiagnosticContext();
  await persistBrowserDiagnostic({ source: "react-boundary", message: "crash", diagnostics });
  for (let i = 0; i < 30; i++) {
    await persistBrowserDiagnostic({ source: "error", message });
  }
  vi.resetModules();
  const { exportBrowserDiagnostics } = await import("./renderer-diagnostics-browser");
  const blobs: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return "blob:test";
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  await exportBrowserDiagnostics(captureDiagnosticContext());
  const exported = JSON.parse(await blobs[0].text());
  expect(exported.reports).toHaveLength(10);
  expect(exported.reports[0].error.diagnostics.reportId).toBe(diagnostics.reportId);
  expect(exported.reports[0].error.message).toBe("crash");
});
