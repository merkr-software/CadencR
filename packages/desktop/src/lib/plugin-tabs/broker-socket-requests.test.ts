import { expect, it, vi } from "vitest";
import { createWsConnection } from "@/lib/ws-connection";
import { SocketRequests } from "./broker-socket-requests";
import { FakePluginSocket } from "./plugin-socket-fixtures";

it("bounds pending calls and times out without replaying or retaining them", async () => {
  vi.useFakeTimers();
  const requests = new SocketRequests();
  const socket = new FakePluginSocket("ws://service", "grant");
  const connection = createWsConnection({
    url: socket.url,
    createSocket: () => socket,
    onMessage: () => undefined,
  });
  socket.open();
  try {
    const calls = Array.from({ length: 64 }, () =>
      requests.send(connection, "backend.request", {}, 100),
    );
    const results = Promise.allSettled(calls);
    await expect(requests.send(connection, "backend.request", {})).rejects.toMatchObject({
      code: "PLUGIN_BACKEND_BUSY",
    });
    await vi.advanceTimersByTimeAsync(100);
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(socket.sent).toHaveLength(64);
    const fresh = requests.send(connection, "backend.request", {});
    requests.rejectAll("closed");
    await expect(fresh).rejects.toMatchObject({ code: "DISCONNECTED" });
  } finally {
    requests.rejectAll("done");
    vi.useRealTimers();
  }
});

it("rejects a call on a closed connection immediately without retaining its timeout", async () => {
  vi.useFakeTimers();
  const requests = new SocketRequests();
  const socket = new FakePluginSocket("ws://service", "grant");
  const connection = createWsConnection({
    url: socket.url,
    createSocket: () => socket,
    onMessage: () => undefined,
  });
  socket.open();
  connection.close();
  try {
    await expect(requests.send(connection, "backend.request", {})).rejects.toMatchObject({
      code: "DISCONNECTED",
    });
    expect(socket.sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    requests.rejectAll("done");
    vi.useRealTimers();
  }
});
