import { expect, it, vi } from "vitest";
import { installMainTelemetry } from "./main-telemetry";
import { relayRemoteDiagnostic } from "./telemetry-relay";

vi.mock("./telemetry-relay", () => ({ relayRemoteDiagnostic: vi.fn() }));
it("installs one monitor and projects only app frames", () => {
  const on = vi.fn();
  const target = { on };
  installMainTelemetry(target);
  installMainTelemetry(target);
  expect(on).toHaveBeenCalledTimes(1);
  expect(on.mock.calls[0][0]).toBe("uncaughtExceptionMonitor");
  const error = new Error("private prompt");
  error.stack = "Error: private prompt\n at privateName (/home/alice/app/out/main/index.js:10:20)";
  on.mock.calls[0][1](error);
  expect(relayRemoteDiagnostic).toHaveBeenCalledWith({
    category: "electron_main",
    frames: [{ filename: "main/index.js", lineno: 10, colno: 20 }],
  });
});
