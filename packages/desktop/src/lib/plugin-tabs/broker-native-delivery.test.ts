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

it("coalesces repeated control notifications while the guest is not consuming", () => {
  const publish = vi.fn();
  const delivery = new NativeDelivery(publish);
  delivery.register("b1");
  for (let n = 0; n < 1000; n++) {
    delivery.resync("b1");
    delivery.error("b1", { code: "EXITED", message: "stopped" });
  }
  expect(publish).toHaveBeenCalledTimes(2);
});
