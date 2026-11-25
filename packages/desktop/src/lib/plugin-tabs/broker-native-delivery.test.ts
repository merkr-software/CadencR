import { expect, it, vi } from "vitest";
import { NativeDelivery } from "./broker-native-delivery";

it("bounds unread guest events, owes a resync and releases every window on reload", () => {
  const publish = vi.fn();
  const delivery = new NativeDelivery(publish, 2);
  delivery.register("b1");
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

it("re-arms resync on the guest ack, coalesces while one is owed", () => {
  const publish = vi.fn();
  const delivery = new NativeDelivery(publish);
  delivery.register("b1");
  // First resync is sent.
  delivery.resync("b1");
  expect(publish).toHaveBeenCalledTimes(1);
  // While the first is still owed, repeated resyncs coalesce.
  delivery.resync("b1");
  delivery.resync("b1");
  expect(publish).toHaveBeenCalledTimes(1);
  // Only the guest's ack proves it read the previous resync: the next one is
  // sent once a delivered event is acknowledged.
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
