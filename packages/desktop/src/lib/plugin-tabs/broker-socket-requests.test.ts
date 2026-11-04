import { expect, it, vi } from "vitest";
import { SocketRequests } from "./broker-socket-requests";
import { FakePluginSocket } from "./plugin-socket-fixtures";

it("bounds pending calls and times out without replaying or retaining them", async () => {
  vi.useFakeTimers();
  const requests = new SocketRequests();
  const socket = new FakePluginSocket("ws://service", "grant");
  try {
    const calls = Array.from({ length: 64 }, () =>
      requests.send(socket, "backend.request", {}, 100),
    );
    const results = Promise.allSettled(calls);
    await expect(requests.send(socket, "backend.request", {})).rejects.toMatchObject({
      code: "PLUGIN_BACKEND_BUSY",
    });
    await vi.advanceTimersByTimeAsync(100);
    expect((await results).every((result) => result.status === "rejected")).toBe(true);
    expect(socket.sent).toHaveLength(64);
    const fresh = requests.send(socket, "backend.request", {});
    requests.rejectAll("closed");
    await expect(fresh).rejects.toMatchObject({ code: "DISCONNECTED" });
  } finally {
    requests.rejectAll("done");
    vi.useRealTimers();
  }
});
