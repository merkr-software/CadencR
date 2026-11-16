import { CadencrError, toCadencrError } from "./errors.js";
import type { EventMap, StreamEnvelope, StreamTopic } from "./protocol.js";
import type { Requester } from "./requester.js";

export interface StreamEvent {
  topic: string;
  /** Per-subscription sequence number, starting at 1. */
  seq: number;
  data: StreamEnvelope;
}

export interface SubscribeOptions {
  /** Topic parameters forwarded to the service. */
  params?: Record<string, unknown>;
  /** Events were lost (a `seq` gap, a host resync, or a reconnect): refetch. */
  onResync?: () => void;
  /** The subscription failed or the host reported a stream error. Without it,
   *  errors go to the client's `onError` listeners. */
  onError?: (error: CadencrError) => void;
}

export interface StreamSubscription {
  unsubscribe(): void;
}

export interface CadencrStreams {
  subscribe(
    topic: StreamTopic | (string & {}),
    handler: (event: StreamEvent) => void,
    options?: SubscribeOptions,
  ): StreamSubscription;
}

interface Subscription {
  topic: string;
  handler: (event: StreamEvent) => void;
  options: SubscribeOptions;
  id: string | null;
  lastSeq: number;
  active: boolean;
  /** Bumped per `open`, so a reconnect supersedes a subscribe in flight. */
  attempt: number;
}

/** Client-side subscription bookkeeping: id mapping, gap detection and
 *  re-subscription after a reconnect. */
export class StreamRegistry implements CadencrStreams {
  private readonly subscriptions = new Set<Subscription>();
  private readonly byId = new Map<string, Subscription>();

  constructor(
    private readonly send: Requester,
    private readonly reportError: (error: CadencrError) => void,
  ) {}

  subscribe(
    topic: string,
    handler: (event: StreamEvent) => void,
    options: SubscribeOptions = {},
  ): StreamSubscription {
    const sub: Subscription = {
      topic,
      handler,
      options,
      id: null,
      lastSeq: 0,
      active: true,
      attempt: 0,
    };
    this.subscriptions.add(sub);
    void this.open(sub, false);
    return { unsubscribe: () => this.close(sub) };
  }

  /** After a reconnect the host forgot every subscription: open them again and
   *  tell each one to resync. */
  resubscribeAll(): void {
    this.byId.clear();
    for (const sub of this.subscriptions) {
      sub.id = null;
      void this.open(sub, true);
    }
  }

  handleEvent<E extends "stream.event" | "stream.resync" | "stream.error">(
    event: E,
    payload: EventMap[E],
  ): void {
    const sub = this.byId.get(payload.subscriptionId);
    // Events for a subscription this client no longer tracks (closed, or from
    // before a reconnect) have no consumer.
    if (!sub || !sub.active) return;
    if (event === "stream.resync") {
      sub.options.onResync?.();
    } else if (event === "stream.error") {
      const { error } = payload as EventMap["stream.error"];
      this.fail(sub, CadencrError.fromWire(error));
    } else {
      this.deliver(sub, payload as EventMap["stream.event"]);
    }
  }

  /** Closes every subscription (the client is closing). Unsubscribe requests
   *  are posted before the connection goes away. */
  closeAll(): void {
    for (const sub of [...this.subscriptions]) this.close(sub);
  }

  private deliver(sub: Subscription, { seq, data }: EventMap["stream.event"]): void {
    if (seq <= sub.lastSeq) return; // duplicate or replay: already delivered
    const gap = seq > sub.lastSeq + 1;
    sub.lastSeq = seq;
    if (gap) sub.options.onResync?.();
    sub.handler({ topic: sub.topic, seq, data });
  }

  private async open(sub: Subscription, resync: boolean): Promise<void> {
    const attempt = ++sub.attempt;
    let subscriptionId: string;
    try {
      ({ subscriptionId } = await this.send("streams.subscribe", {
        topic: sub.topic,
        params: sub.options.params,
      }));
    } catch (error) {
      // Unsubscribed, or re-opened on a newer connection, while the request
      // was in flight: nobody wants this outcome.
      if (!sub.active || sub.attempt !== attempt) return;
      sub.active = false;
      this.subscriptions.delete(sub);
      this.fail(sub, toCadencrError(error));
      return;
    }
    if (!sub.active) {
      void this.release(subscriptionId).catch((error: unknown) =>
        this.fail(sub, toCadencrError(error)),
      );
      return;
    }
    // The id belongs to a connection a reconnect already replaced.
    if (sub.attempt !== attempt) return;
    sub.id = subscriptionId;
    sub.lastSeq = 0;
    this.byId.set(subscriptionId, sub);
    if (resync) sub.options.onResync?.();
  }

  private close(sub: Subscription): void {
    if (!sub.active) return;
    sub.active = false;
    this.subscriptions.delete(sub);
    if (sub.id === null) return; // `open` releases it once the id arrives
    this.byId.delete(sub.id);
    void this.release(sub.id).catch((error: unknown) => this.fail(sub, toCadencrError(error)));
  }

  private async release(subscriptionId: string): Promise<void> {
    try {
      await this.send("streams.unsubscribe", { subscriptionId });
    } catch (error) {
      // A lost connection already dropped the subscription host-side.
      if (error instanceof CadencrError && error.code === "DISCONNECTED") return;
      throw error;
    }
  }

  private fail(sub: Subscription, error: CadencrError): void {
    if (sub.options.onError) sub.options.onError(error);
    else this.reportError(error);
  }
}
