import { afterEach, describe, expect, it, vi } from "vitest";

import { GrantHolder } from "./broker-grant";
import { PluginStreamSocket, type StreamSink } from "./broker-streams";
import { FakePluginSocket as FakeSocket } from "./plugin-socket-fixtures";

let instanceCounter = 0;

function setup() {
  const sockets: FakeSocket[] = [];
  const grant = new GrantHolder("graph", 7, {
    mint: vi.fn(async () => ({
      token: `tok${sockets.length}`,
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      scopes: ["git:read"],
      api_version: 1,
    })),
    revoke: vi.fn(async () => undefined),
    reportRevokeFailure: vi.fn(),
    now: () => Date.now(),
  });
  const sink: StreamSink = { event: vi.fn(), resync: vi.fn(), error: vi.fn() };
  const streams = new PluginStreamSocket({
    instanceId: `7:plugin:graph-${++instanceCounter}`,
    grant,
    sink,
    createSocket: (url, protocol) => {
      const socket = new FakeSocket(url, protocol);
      sockets.push(socket);
      return socket;
    },
    url: () => "ws://service/api/plugin-tabs/ws",
  });
  return { sockets, sink, streams, grant };
}

/** Let pending promise callbacks run (fake timers). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!check()) throw new Error("not yet");
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PluginStreamSocket", () => {
  it("subscribes over the plugin socket and forwards events under a local id", async () => {
    const { sockets, sink, streams } = setup();
    const subscribing = streams.subscribe("git.status");
    await until(() => sockets.length === 1);
    const socket = sockets[0]!;
    expect(socket.protocol).toBe("cadencr-plugin.tok0");
    socket.open();
    await until(() => socket.sent.length === 1);
    const request = socket.lastRequest();
    expect(request).toMatchObject({ action: "subscribe", payload: { topic: "git.status" } });
    socket.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "subscribed",
      ref: request.id,
      payload: { subscription_id: "srv-1" },
    });
    const localId = await subscribing;
    socket.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "event",
      payload: {
        subscription_id: "srv-1",
        topic: "git.status",
        seq: 1,
        envelope: { domain: "git", action: "status", payload: { dirty: true } },
      },
    });
    expect(sink.event).toHaveBeenCalledWith(localId, 1, {
      domain: "git",
      action: "status",
      payload: { dirty: true },
    });
    socket.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "resync",
      payload: { subscription_id: "srv-1", topic: "git.status" },
    });
    expect(sink.resync).toHaveBeenCalledWith(localId);
    streams.dispose();
  });

  it("rejects a refused subscription with the server's code", async () => {
    const { sockets, streams } = setup();
    const subscribing = streams.subscribe("session.stream");
    await until(() => sockets.length === 1);
    sockets[0]!.open();
    await until(() => sockets[0]!.sent.length === 1);
    sockets[0]!.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "error",
      ref: sockets[0]!.lastRequest().id,
      payload: { code: "PLUGIN_SCOPE_DENIED", message: "agent:observe not granted" },
    });
    await expect(subscribing).rejects.toMatchObject({ code: "PLUGIN_SCOPE_DENIED" });
    streams.dispose();
  });

  it("reconnects after a drop, resubscribes and asks the guest to resync", async () => {
    const { sockets, sink, streams } = setup();
    const subscribing = streams.subscribe("git.status");
    await until(() => sockets.length === 1);
    sockets[0]!.open();
    await until(() => sockets[0]!.sent.length === 1);
    sockets[0]!.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "subscribed",
      ref: sockets[0]!.lastRequest().id,
      payload: { subscription_id: "srv-1" },
    });
    const localId = await subscribing;
    for (const seq of [1, 2, 3]) {
      sockets[0]!.receive({
        id: crypto.randomUUID(),
        domain: "plugin",
        action: "event",
        payload: { subscription_id: "srv-1", seq, envelope: { domain: "git", action: "status" } },
      });
    }
    expect(sink.event).toHaveBeenLastCalledWith(localId, 3, expect.anything());

    vi.useFakeTimers();
    sockets[0]!.drop(1008);
    // The shared backoff's first retry lands within a second.
    await vi.advanceTimersByTimeAsync(1_100);
    vi.useRealTimers();
    await until(() => sockets.length === 2);
    const second = sockets[1]!;
    second.open();
    await until(() => second.sent.length === 1);
    second.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "subscribed",
      ref: second.lastRequest().id,
      payload: { subscription_id: "srv-2" },
    });
    await until(() => vi.mocked(sink.resync).mock.calls.length === 1);
    expect(sink.resync).toHaveBeenCalledWith(localId);
    second.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "event",
      payload: {
        subscription_id: "srv-2",
        seq: 1,
        envelope: { domain: "git", action: "status", payload: null },
      },
    });
    // The new server subscription counts from 1; the guest's seq carries on.
    expect(sink.event).toHaveBeenLastCalledWith(localId, 4, {
      domain: "git",
      action: "status",
      payload: null,
    });
    streams.dispose();
  });

  it("drops the old page's subscriptions on reset (guest reload)", async () => {
    const { sockets, sink, streams } = setup();
    const subscribing = streams.subscribe("git.status");
    await until(() => sockets.length === 1);
    sockets[0]!.open();
    await until(() => sockets[0]!.sent.length === 1);
    sockets[0]!.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "subscribed",
      ref: sockets[0]!.lastRequest().id,
      payload: { subscription_id: "srv-1" },
    });
    await subscribing;
    streams.reset();
    expect(sockets[0]!.readyState).toBe(3);
    sockets[0]!.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "event",
      payload: { subscription_id: "srv-1", seq: 2, envelope: { domain: "git", action: "status" } },
    });
    expect(sink.event).not.toHaveBeenCalled();
    streams.dispose();
  });
  it("binds a subscription once when a reconnect races a fresh subscribe", async () => {
    vi.useFakeTimers();
    const { sockets, sink, streams } = setup();
    const first = streams.subscribe("git.status");
    await settle();
    sockets[0]!.open();
    await settle();
    sockets[0]!.acceptSubscribe("git.status", "srv-1");
    const firstId = await first;

    // The socket drops (a reconnect is armed), then the guest subscribes again
    // before that reconnect fires: the fresh subscribe opens the new socket.
    sockets[0]!.drop();
    const second = streams.subscribe("session.list");
    await settle();
    expect(sockets).toHaveLength(2);
    const socket = sockets[1]!;
    socket.open();
    await settle();
    // Its own subscribe, plus the dropped one re-made — nothing more.
    expect(socket.subscribes().map((message) => message.payload.topic)).toEqual(
      expect.arrayContaining(["session.list", "git.status"]),
    );
    expect(socket.subscribes()).toHaveLength(2);
    socket.acceptSubscribe("session.list", "srv-2");
    socket.acceptSubscribe("git.status", "srv-3");
    const secondId = await second;
    await settle();

    // The armed reconnect fires later and must find nothing left to bind.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    expect(socket.subscribes()).toHaveLength(2);
    expect(sink.resync).toHaveBeenCalledTimes(1);
    expect(sink.resync).toHaveBeenCalledWith(firstId);

    socket.receive({
      id: crypto.randomUUID(),
      domain: "plugin",
      action: "event",
      payload: { subscription_id: "srv-2", seq: 1, envelope: { domain: "s", action: "a" } },
    });
    expect(sink.event).toHaveBeenCalledTimes(1);
    expect(sink.event).toHaveBeenCalledWith(secondId, 1, expect.anything());
    streams.dispose();
  });

  it("re-mints the grant when the upgrade is refused (closed before open)", async () => {
    vi.useFakeTimers();
    const { sockets, streams } = setup();
    const refused = streams.subscribe("git.status");
    await settle();
    expect(sockets[0]!.protocol).toBe("cadencr-plugin.tok0");
    sockets[0]!.drop(1006);
    await expect(refused).rejects.toMatchObject({ code: "DISCONNECTED" });
    void streams.subscribe("git.status");
    await settle();
    expect(sockets[1]!.protocol).toBe("cadencr-plugin.tok1");
    streams.dispose();
  });

  it("closes the socket once the last subscription goes", async () => {
    vi.useFakeTimers();
    const { sockets, streams } = setup();
    const subscribing = streams.subscribe("git.status");
    await settle();
    sockets[0]!.open();
    await settle();
    sockets[0]!.acceptSubscribe("git.status", "srv-1");
    streams.unsubscribe(await subscribing);
    expect(sockets[0]!.lastRequest()).toMatchObject({
      action: "unsubscribe",
      payload: { subscription_id: "srv-1" },
    });
    expect(sockets[0]!.readyState).toBe(3);
    streams.dispose();
  });
});
