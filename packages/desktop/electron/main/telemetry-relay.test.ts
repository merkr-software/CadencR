import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";

const runtime = vi.hoisted(() => ({
  baseUrl: "http://127.0.0.1:5005",
  authToken: null as string | null,
}));
const shell = vi.hoisted(() => ({ isPackaged: false, getAppPath: () => "/unavailable" }));
vi.mock("electron", () => ({ app: shell }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  readdirSync: vi.fn(),
}));
vi.mock("./runtime-config", () => ({ getRuntimeConfig: () => runtime }));

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  runtime.authToken = null;
  shell.isPackaged = false;
  vi.mocked(readdirSync).mockReturnValue([]);
});
describe("best effort diagnostic relay", () => {
  it("fails closed without the service credential", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const relay = await import("./telemetry-relay");
    relay.relayRemoteDiagnostic({ category: "electron_main", frames: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(relay.telemetryRelayStatus()).toBe("unavailable");
  });
  it("bounds offline requests without a retry or persistent queue", async () => {
    runtime.authToken = "local-token";
    let reject: ((reason: Error) => void) | undefined;
    const fetch = vi.fn(
      (_url: string, _options: RequestInit) =>
        new Promise<Response>((_resolve, fail) => {
          reject = fail;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const relay = await import("./telemetry-relay");
    for (let i = 0; i < 100; i += 1)
      relay.relayRemoteDiagnostic({ category: "electron_main", frames: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:5005/api/telemetry/diagnostics");
    reject?.(new Error("offline"));
    await vi.waitFor(() => expect(relay.telemetryRelayStatus()).toBe("unavailable"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it.each(["/Applications/Cadencr.app/Contents/Resources", "/opt/Cadencr/resources"])(
  "reads the exact packaged renderer allowlist under %s",
  async (resources) => {
    shell.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", { configurable: true, value: resources });
    vi.mocked(readdirSync).mockReturnValue([
      "index-AbCd1234.js",
      "private.txt",
      "index-AbCd1234.js.map",
    ] as never);
    const relay = await import("./telemetry-relay");
    expect([...relay.rendererTelemetryAssets()]).toEqual(["index-AbCd1234.js"]);
    expect(readdirSync).toHaveBeenCalledWith(`${resources}/renderer/assets`);
  },
);
it("relays only the prepared allowlist payload including exact build ID to the local service", async () => {
  runtime.authToken = "local-token";
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const relay = await import("./telemetry-relay");
  const event = {
    category: "react_boundary" as const,
    build_id: "abc123-linux-uuid",
    frames: [{ filename: "assets/index-AbCd1234.js", lineno: 1, colno: 2 }],
  };
  relay.relayRemoteDiagnostic(event);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(event);
  expect(fetch.mock.calls[0][1].redirect).toBe("error");
});
