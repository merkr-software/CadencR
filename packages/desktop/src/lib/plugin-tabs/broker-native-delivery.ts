import type { EventMap, EventName, WireError } from "@cadencr/tab-sdk/protocol";

type Publish = <E extends EventName>(name: E, payload: EventMap[E]) => void;
type NativeEvent = EventMap["backend.event"];
interface Window {
  pending: Set<number>;
  explicitResyncAck: boolean;
  owed: boolean;
  resyncId: number | null;
  errorSent: boolean;
}

/** Bound native IPC delivery even when the guest stops reading its port.
 * WebSocket backpressure alone cannot see an unread MessagePort. */
export class NativeDelivery {
  private readonly windows = new Map<string, Window>();
  private nextResyncId = 0;
  constructor(
    private readonly publish: Publish,
    private readonly capacity = 32,
  ) {}

  register(id: string, explicitResyncAck: boolean): void {
    this.windows.set(id, {
      pending: new Set(),
      explicitResyncAck,
      owed: false,
      resyncId: null,
      errorSent: false,
    });
  }

  release(id: string): void {
    this.windows.delete(id);
  }

  reset(): void {
    this.windows.clear();
  }

  event(event: NativeEvent): void {
    const window = this.windows.get(event.subscriptionId);
    if (!window) return;
    if (window.pending.size >= this.capacity) {
      window.owed = true;
      return;
    }
    this.pay(event.subscriptionId, window);
    window.pending.add(event.seq);
    this.publish("backend.event", event);
  }

  ack(id: string, seq: number): void {
    const window = this.windows.get(id);
    if (!window?.pending.delete(seq)) return;
    // Earlier SDKs only acknowledge data events.
    if (!window.explicitResyncAck) window.resyncId = null;
    window.errorSent = false;
    this.pay(id, window);
  }

  ackResync(id: string, resyncId: number): void {
    const window = this.windows.get(id);
    if (!window?.explicitResyncAck || window.resyncId !== resyncId) return;
    window.resyncId = null;
    this.pay(id, window);
  }

  error(id: string, error: WireError): void {
    const window = this.windows.get(id);
    if (!window || window.errorSent) return;
    window.errorSent = true;
    this.publish("backend.error", { subscriptionId: id, error });
  }

  resync(id: string): void {
    const window = this.windows.get(id);
    if (!window) return;
    window.owed = true;
    this.pay(id, window);
  }

  private pay(id: string, window: Window): void {
    if (!window.owed || window.resyncId !== null || window.pending.size >= this.capacity) return;
    window.owed = false;
    // Keep at most one unread resync plus one owed notification, even if
    // repeated reconnects come from a quiet backend with no data events.
    const resyncId = ++this.nextResyncId;
    window.resyncId = resyncId;
    this.publish("backend.resync", {
      subscriptionId: id,
      ...(window.explicitResyncAck ? { resyncId } : {}),
    });
  }
}
