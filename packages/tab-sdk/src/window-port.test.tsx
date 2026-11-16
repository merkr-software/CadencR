import { describe, expect, it } from "vitest";
import { connect } from "./index.js";
import { flush } from "./test-utils.js";
import { createTestHost } from "./testing/index.js";

/** What the guest preload does after `load`: a window message carrying the port. */
function postPortFromPreload(port: MessagePort, source: unknown = window): void {
  const event = new Event("message");
  Object.defineProperties(event, {
    data: { value: { type: "cadencr-tab:port" } },
    ports: { value: [port] },
    source: { value: source },
  });
  window.dispatchEvent(event);
}

describe("window port bootstrap", () => {
  it("buffers a port posted before connect() and re-handshakes on a reload's new port", async () => {
    const first = createTestHost();
    // Arrives at import time + load, long before the app calls connect().
    postPortFromPreload(first.port);
    // A forged message from another source is ignored.
    const stranger = createTestHost();
    postPortFromPreload(stranger.port, {});
    await flush();

    const client = await connect({ applyTheme: false });
    expect(client.instanceId).toBe("test-instance");
    expect(first.requests.map((r) => r.method)).toEqual(["hello"]);
    expect(stranger.requests).toEqual([]);

    const reloaded = createTestHost({ instanceId: "after-reload" });
    postPortFromPreload(reloaded.port);
    await flush(30);
    expect(reloaded.requests.map((r) => r.method)).toEqual(["hello"]);
    expect(client.instanceId).toBe("after-reload");
    await expect(client.storage.list()).resolves.toEqual([]);

    client.close();
    for (const host of [first, stranger, reloaded]) host.close();
  });
});
