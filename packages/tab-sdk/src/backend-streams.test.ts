import { expect, it, vi } from "vitest";
import { connected } from "./test-utils.js";

it("refuses subscriptions on an older host before sending any request", async () => {
  const { host, client } = await connected();
  try {
    await expect(client.backend.subscribe("clock.tick", () => {})).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    expect(host.requests).toHaveLength(1);
  } finally {
    client.close();
    host.close();
  }
});

it("awaits registration, detects gaps and process changes, and releases the subscription", async () => {
  const { host, client } = await connected({ capabilities: ["backend.subscribe"] });
  const seen = vi.fn();
  const onResync = vi.fn();
  const onError = vi.fn();
  try {
    const subscription = await client.backend.subscribe("clock.tick", seen, { onResync, onError });
    const request = host.requests.find((r) => r.method === "backend.subscribe");
    expect(request?.params).toEqual({ topic: "clock.tick" });
    const [id] = host.subscriptions.keys();
    const emit = (seq: number, runId: string) =>
      host.emit("backend.event", {
        subscriptionId: id!,
        topic: "clock.tick",
        runId,
        seq,
        processSeq: seq,
        payload: { tick: seq },
      });
    emit(1, "run-1");
    emit(3, "run-1");
    emit(3, "run-1");
    emit(4, "run-2");
    await vi.waitFor(() => {
      expect(seen.mock.calls.map(([event]) => event.payload)).toEqual([
        { tick: 1 },
        { tick: 3 },
        { tick: 4 },
      ]);
    });
    expect(onResync).toHaveBeenCalledTimes(2);
    // Acks are sent fire-and-forget over the port: wait until the host has
    // recorded all four instead of relying on a fixed timer.
    await vi.waitFor(() => {
      expect(host.requests.filter((r) => r.method === "backend.ack").map((r) => r.params)).toEqual([
        { subscriptionId: id, seq: 1 },
        { subscriptionId: id, seq: 3 },
        { subscriptionId: id, seq: 3 },
        { subscriptionId: id, seq: 4 },
      ]);
    });
    host.emit("backend.error", {
      subscriptionId: id!,
      error: { code: "PLUGIN_BACKEND_EXITED", message: "exited" },
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "PLUGIN_BACKEND_EXITED" }),
      );
    });
    subscription.unsubscribe();
    await vi.waitFor(() => {
      expect(host.subscriptions.size).toBe(0);
    });
  } finally {
    client.close();
    host.close();
  }
});

it("re-subscribes after a host reload and never replays backend requests", async () => {
  const { host, client } = await connected({ capabilities: ["backend.subscribe"] });
  const onResync = vi.fn();
  const onError = vi.fn();
  try {
    const sub = await client.backend.subscribe("clock.tick", () => {}, { onResync, onError });
    host.handle("backend.request", () => ({ result: null }));
    await client.backend.request("increment");
    host.reconnect();
    await vi.waitFor(() => {
      expect(host.requests.filter((r) => r.method === "backend.subscribe")).toHaveLength(2);
    });
    expect(host.requests.filter((r) => r.method === "backend.request")).toHaveLength(1);
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    sub.unsubscribe();
    await vi.waitFor(() => {
      expect(host.subscriptions.size).toBe(0);
    });
  } finally {
    client.close();
    host.close();
  }
});

it("keeps a logical subscription alive when a rebind is interrupted by another host replacement", async () => {
  const { host, client } = await connected({ capabilities: ["backend.subscribe"] });
  const seen = vi.fn();
  const onResync = vi.fn();
  const onError = vi.fn();
  try {
    const sub = await client.backend.subscribe("clock.tick", seen, { onResync, onError });
    let rebinds = 0;
    host.handle("backend.subscribe", () => {
      rebinds += 1;
      // The first rebind stays pending until its port is replaced.
      if (rebinds === 1) return new Promise<{ subscriptionId: string }>(() => {});
      return { subscriptionId: `backend-rebound-${rebinds}` };
    });
    host.reconnect();
    // Wait until the first rebind request is in flight (held by the handler).
    await vi.waitFor(() => {
      expect(host.requests.filter((r) => r.method === "backend.subscribe")).toHaveLength(2);
    });
    host.reconnect();
    await vi.waitFor(() => {
      expect(host.requests.filter((r) => r.method === "backend.subscribe")).toHaveLength(3);
    });
    // The interrupted rebind is transient: no error, and the second
    // replacement rebound the original logical subscription.
    expect(onError).not.toHaveBeenCalled();
    expect(onResync).toHaveBeenCalledTimes(1);
    host.emit("backend.event", {
      subscriptionId: "backend-rebound-2",
      topic: "clock.tick",
      runId: "run-1",
      seq: 1,
      processSeq: 1,
      payload: { tick: 1 },
    });
    await vi.waitFor(() => {
      expect(seen).toHaveBeenCalledTimes(1);
    });
    sub.unsubscribe();
    await vi.waitFor(() => {
      expect(host.requests.some((r) => r.method === "backend.unsubscribe")).toBe(true);
    });
  } finally {
    client.close();
    host.close();
  }
});

it("releases an acknowledged subscription when the client closes during registration", async () => {
  const { host, client } = await connected({ capabilities: ["backend.subscribe"] });
  try {
    const subscribe = client.backend.subscribe("clock.tick", () => {});
    client.close();
    await expect(subscribe).rejects.toMatchObject({ code: "DISCONNECTED" });
  } finally {
    client.close();
    host.close();
  }
});
