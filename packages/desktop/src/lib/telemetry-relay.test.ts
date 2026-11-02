import { beforeEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn());
const context = vi.hoisted(() => ({ remote: false }));
vi.mock("./remote/device-token", () => ({ isBrowserRemote: () => context.remote }));
vi.mock("@/api/generated", () => ({ ingestDiagnostic: request }));
beforeEach(() => {
  vi.resetModules();
  request.mockReset();
  context.remote = false;
});
it("local development browsers send categories without untrusted stack filenames", async () => {
  request.mockResolvedValue({});
  const relay = await import("./telemetry-relay");
  relay.relayBrowserDiagnostic({
    source: "error",
    message: "private",
    stack: "Error\n at /home/private/assets/secret.js:1:2",
  });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(request.mock.calls[0][0]).toEqual({
    category: "renderer_unhandled_error",
    frames: [],
  });
});
it("drops offline reports without a retry or toast storm and exposes failure", async () => {
  request.mockRejectedValue(new Error("offline"));
  const relay = await import("./telemetry-relay");
  for (let i = 0; i < 20; i += 1)
    relay.relayBrowserDiagnostic({ source: "error", message: "private" });
  await vi.waitFor(async () =>
    expect(await relay.browserTelemetryRelayStatus()).toBe("unavailable"),
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it("never posts telemetry from paired remote clients", async () => {
  context.remote = true;
  const relay = await import("./telemetry-relay");
  relay.relayBrowserDiagnostic({ source: "error", message: "private" });
  expect(request).not.toHaveBeenCalled();
});
