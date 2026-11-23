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

it("re-arms resync after the guest consumes it, coalesces errors", () => {
  const publish = vi.fn();
  const delivery = new NativeDelivery(publish);
  delivery.register("b1");
  // Each resync from the guest means the previous one was consumed (e.g. by
  // reading a snapshot), so a later reconnect can request another even before
  // any data event is acknowledged.
  delivery.resync("b1");
  delivery.resync("b1");
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenNthCalledWith(1, "backend.resync", { subscriptionId: "b1" });
  expect(publish).toHaveBeenNthCalledWith(2, "backend.resync", { subscriptionId: "b1" });
  // Errors still coalesce while the guest is not consuming.
  for (let n = 0; n < 1000; n++) {
    delivery.error("b1", { code: "EXITED", message: "stopped" });
  }
  expect(publish).toHaveBeenCalledTimes(3);
});
