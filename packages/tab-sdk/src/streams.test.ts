import { describe, expect, it, vi } from "vitest";
import type { CadencrError } from "./errors.js";
import type { StreamEvent } from "./streams.js";
import { connected, flush } from "./test-utils.js";

const envelope = (n: number) => ({ domain: "git", action: "status", payload: { n } });

describe("streams", () => {
  it("delivers events in order and detects seq gaps", async () => {
    const { host, client } = await connected();
    const seen: number[] = [];
    const onResync = vi.fn();
    client.streams.subscribe("git.status", (event: StreamEvent) => seen.push(event.seq), {
      params: { feature_id: 10 },
      onResync,
    });
    await flush();
    expect([...host.subscriptions.values()]).toEqual([
      { topic: "git.status", params: { feature_id: 10 } },
    ]);
    host.pushStream("git.status", envelope(1));
    host.pushStream("git.status", envelope(2));
    host.pushStream("git.status", envelope(5), { seq: 5 });
    host.pushStream("git.status", envelope(5), { seq: 5 }); // duplicate
    await flush();
    expect(seen).toEqual([1, 2, 5]);
    expect(onResync).toHaveBeenCalledTimes(1);
    client.close();
    host.close();
  });

  it("forwards host resync and error events", async () => {
    const { host, client } = await connected();
    const onResync = vi.fn();
    const onError = vi.fn();
    client.streams.subscribe("session.stream", () => {}, { onResync, onError });
    await flush();
    const [id] = host.subscriptions.keys();
    host.resync(id!);
    host.streamError(id!, { code: "PLUGIN_SCOPE_DENIED", message: "no" });
    await flush();
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "PLUGIN_SCOPE_DENIED" }));
    client.close();
    host.close();
  });

  it("sends errors without an onError to client.onError", async () => {
    const { host, client } = await connected();
    host.handle("streams.subscribe", () => {
      throw Object.assign(new Error("denied"), { code: "X" });
    });
    const errors: CadencrError[] = [];
    client.onError((error) => errors.push(error));
    client.streams.subscribe("forge.status", () => {});
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("HOST_ERROR");
    client.close();
    host.close();
  });

  it("unsubscribes, including before the subscription id arrives", async () => {
    const { host, client } = await connected();
    const a = client.streams.subscribe("git.status", () => {});
    await flush();
    a.unsubscribe();
    const b = client.streams.subscribe("files.changes", () => {});
    b.unsubscribe();
    await flush();
    expect(host.subscriptions.size).toBe(0);
    expect(host.requests.filter((r) => r.method === "streams.unsubscribe")).toHaveLength(2);
    client.close();
    host.close();
  });

  it("re-handshakes and re-subscribes when the host sends a new port", async () => {
    const { host, client } = await connected();
    const seen: unknown[] = [];
    const onResync = vi.fn();
    const contexts = vi.fn();
    const changes: boolean[] = [];
    client.onContextChange(contexts);
    client.onConnectionChange((value) => changes.push(value));
    client.streams.subscribe("git.status", (event) => seen.push(event.data.payload), {
      onResync,
    });
    await flush();
    host.pushStream("git.status", envelope(1));
    await flush();

    host.setContext({ ...host.context, session: { id: 3, provider: "claude", status: "idle" } });
    await flush();
    contexts.mockClear();
    host.reconnect();
    await flush(30);
    expect(host.requests.filter((r) => r.method === "hello")).toHaveLength(2);
    expect(host.subscriptions.size).toBe(1);
    expect(onResync).toHaveBeenCalledTimes(1);
    host.pushStream("git.status", envelope(2));
    await flush();
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    expect(changes).toEqual([true]);
    expect(client.connected).toBe(true);
    client.close();
    host.close();
  });
});
