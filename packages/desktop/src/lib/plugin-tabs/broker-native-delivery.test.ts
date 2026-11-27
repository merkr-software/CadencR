import { expect, it, vi } from "vitest";
import { NativeDelivery } from "./broker-native-delivery";

it("bounds unread guest events, owes a resync and releases every window on reload", () => {
  const publish = vi.fn();
  const delivery = new NativeDelivery(publish, 2);
  delivery.register("b1", false);
  const event = (seq: number) => ({
    subscriptionId: "b1",
    topic: "clock.tick",
    seq,
    processSeq: seq,
    runId: "r",
    payload: null,
  });
  for (let seq = 1; seq <= 1000; seq++) delivery.event(event(seq));
  expect(publish).toHaveBeenCalledTimes(2);
  delivery.ack("b1", 999);
  expect(publish).toHaveBeenCalledTimes(2);
  delivery.ack("b1", 1);
  expect(publish).toHaveBeenLastCalledWith("backend.resync", { subscriptionId: "b1" });
  delivery.event(event(1001));
  expect(publish).toHaveBeenLastCalledWith("backend.event", event(1001));
  delivery.reset();
  delivery.event(event(1002));
  expect(publish).toHaveBeenCalledTimes(4);
});

it("retains data acknowledgements as the resync fallback for older SDKs", () => {
  const publish = vi.fn();
  const delivery = new NativeDelivery(publish);
  delivery.register("b1", false);
  // First resync is sent.
  delivery.resync("b1");
  expect(publish).toHaveBeenCalledTimes(1);
  // While the first is still owed, repeated resyncs coalesce.
  delivery.resync("b1");
  delivery.resync("b1");
  expect(publish).toHaveBeenCalledTimes(1);
  // The older SDK acknowledges a delivered data event after the resync.
  delivery.event({
    subscriptionId: "b1",
    topic: "t",
    seq: 1,
    processSeq: 1,
    runId: "r",
    payload: null,
  });
  delivery.ack("b1", 1);
  delivery.resync("b1");
  expect(publish).toHaveBeenCalledTimes(3); // event + resync
  expect(publish).toHaveBeenLastCalledWith("backend.resync", { subscriptionId: "b1" });
});

it("coalesces unread resyncs and re-arms after an exact acknowledgement without data", () => {
  const publish = vi.fn();
  const delivery = new NativeDelivery(publish);
  delivery.register("b1", true);
  for (let i = 0; i < 1000; i++) delivery.resync("b1");
  expect(publish.mock.calls).toEqual([["backend.resync", { subscriptionId: "b1", resyncId: 1 }]]);

  delivery.ackResync("b1", 999);
  expect(publish).toHaveBeenCalledTimes(1);
  delivery.ackResync("b1", 1);
  expect(publish).toHaveBeenLastCalledWith("backend.resync", { subscriptionId: "b1", resyncId: 2 });

  delivery.resync("b1");
  delivery.ackResync("b1", 1);
  expect(publish).toHaveBeenCalledTimes(2);
  delivery.ackResync("b1", 2);
  expect(publish).toHaveBeenLastCalledWith("backend.resync", { subscriptionId: "b1", resyncId: 3 });

  delivery.ackResync("b1", 3);
  expect(publish).toHaveBeenCalledTimes(3);
  delivery.resync("b1");
  expect(publish).toHaveBeenLastCalledWith("backend.resync", { subscriptionId: "b1", resyncId: 4 });
});
