import { describe, expect, it } from "vitest";
import { connect } from "./connect.js";
import { CadencrError } from "./errors.js";
import { connected, flush } from "./test-utils.js";
import { createTabContext, createTestHost } from "./testing/index.js";
import { SDK_VERSION } from "./version.js";

describe("connect", () => {
  it("performs the hello handshake", async () => {
    const { host, client } = await connected({
      capabilities: ["streams", "net.fetch"],
      instanceId: "inst-1",
      plugin: { id: "graph", version: "1.2.3" },
    });
    expect(host.requests[0]).toMatchObject({
      method: "hello",
      params: { sdkVersion: SDK_VERSION, apiVersions: [1, 1] },
    });
    expect(client.instanceId).toBe("inst-1");
    expect(client.plugin).toEqual({ id: "graph", version: "1.2.3" });
    expect(client.apiVersion).toBe(1);
    expect(client.context.feature.id).toBe(10);
    expect(client.theme.id).toBe("cadencr-dark");
    expect(client.capabilities.isSupported("net.fetch")).toBe(true);
    expect(client.capabilities.isSupported("shell")).toBe(false);
    expect(client.connected).toBe(true);
    client.close();
    host.close();
  });

  it("rejects with PLUGIN_API_UNSUPPORTED when the host speaks no common version", async () => {
    const host = createTestHost({ apiVersions: [2, 3] });
    await expect(connect({ transport: host.transport })).rejects.toMatchObject({
      code: "PLUGIN_API_UNSUPPORTED",
    });
    host.close();
  });

  it("rejects a host that picks a version outside the SDK range", async () => {
    const host = createTestHost();
    host.handle("hello", () => ({
      apiVersion: 7,
      instanceId: "x",
      plugin: { id: "x", version: "0" },
      context: createTabContext(),
      theme: host.theme,
      capabilities: [],
      visible: true,
    }));
    const error = await connect({ transport: host.transport }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CadencrError);
    expect((error as CadencrError).code).toBe("PLUGIN_API_UNSUPPORTED");
    host.close();
  });

  it("times out when hello is never answered", async () => {
    const host = createTestHost();
    host.handle("hello", () => new Promise(() => {}));
    await expect(connect({ transport: host.transport, timeoutMs: 40 })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    host.close();
  });

  it("times out when no port ever arrives", async () => {
    const transport = { subscribe: () => () => {} };
    await expect(connect({ transport, timeoutMs: 30 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("accepts a bare MessagePort as transport", async () => {
    const host = createTestHost();
    const client = await connect({ transport: host.port });
    expect(client.instanceId).toBe("test-instance");
    client.close();
    host.close();
  });

  it("lets two clients share one port (StrictMode re-mount)", async () => {
    const host = createTestHost();
    const first = connect({ transport: host.transport });
    const second = connect({ transport: host.transport });
    const [a, b] = await Promise.all([first, second]);
    a.close();
    await expect(b.storage.list()).resolves.toEqual([]);
    b.close();
    host.close();
  });

  it("rejects requests after close with DISCONNECTED", async () => {
    const { host, client } = await connected();
    client.close();
    await expect(client.config.get()).rejects.toMatchObject({ code: "DISCONNECTED" });
    host.close();
  });

  it("rejects pending requests when the port is lost", async () => {
    const { host, client } = await connected();
    host.handle("config.get", () => new Promise(() => {}));
    const changes: boolean[] = [];
    client.onConnectionChange((value) => changes.push(value));
    const pending = client.config.get();
    await flush();
    host.disconnect();
    await expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(changes).toEqual([false]);
    expect(client.connected).toBe(false);
    client.close();
  });
});
