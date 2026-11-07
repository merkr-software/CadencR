import { CadencrError, toCadencrError } from "./errors.js";
import type { EventMap } from "./protocol.js";
import type { Requester } from "./requester.js";

export type BackendEvent = Omit<EventMap["backend.event"], "subscriptionId">;

export interface BackendSubscribeOptions {
  /** Events were lost, or the backend process changed: request a snapshot. */
  onResync?: () => void;
  /** Without this callback, failures go to client.onError. */
  onError?: (error: CadencrError) => void;
}

export interface BackendSubscription {
  unsubscribe(): void;
}

interface Subscription {
  topic: string;
  handler: (event: BackendEvent) => void;
  options: BackendSubscribeOptions;
  id: string | null;
  active: boolean;
  attempt: number;
  seq: number;
  runId: string | null;
}

/** Native subscriptions only. Backend methods and event payloads stay opaque. */
export class BackendStreams {
  private readonly subscriptions = new Set<Subscription>();
  private readonly byId = new Map<string, Subscription>();

  constructor(
    private readonly send: Requester,
    private readonly supported: () => boolean,
    private readonly reportError: (error: CadencrError) => void,
  ) {}

  async subscribe(
    topic: string,
    handler: (event: BackendEvent) => void,
    options: BackendSubscribeOptions = {},
  ): Promise<BackendSubscription> {
    this.checkSupport();
    const sub: Subscription = {
      topic,
      handler,
      options,
      id: null,
      active: true,
      attempt: 0,
      seq: 0,
      runId: null,
    };
    this.subscriptions.add(sub);
    try {
      await this.open(sub, false);
      return { unsubscribe: () => this.close(sub) };
    } catch (error) {
      this.close(sub);
      throw error;
    }
  }

  resubscribeAll(): void {
    this.byId.clear();
    for (const sub of this.subscriptions) {
      sub.id = null;
      void this.open(sub, true).catch((error: unknown) => {
        if (!sub.active) return;
        this.close(sub);
        this.fail(sub, toCadencrError(error));
      });
    }
  }

  handleEvent(
    event: "backend.event" | "backend.resync" | "backend.error",
    payload: EventMap[typeof event],
  ): void {
    const sub = this.byId.get(payload.subscriptionId);
    if (!sub?.active) return;
    if (event === "backend.resync") sub.options.onResync?.();
    else if (event === "backend.error") {
      this.fail(sub, CadencrError.fromWire((payload as EventMap["backend.error"]).error));
    } else {
      this.deliver(sub, payload as EventMap["backend.event"]);
    }
  }

  closeAll(): void {
    for (const sub of [...this.subscriptions]) this.close(sub);
  }

  private checkSupport(): void {
    if (!this.supported()) {
      throw new CadencrError("CAPABILITY_DENIED", "This host does not support backend.subscribe");
    }
  }

  private deliver(sub: Subscription, event: EventMap["backend.event"]): void {
    // Release the host's bounded delivery window even for duplicate events or
    // a callback that throws. Nothing is acknowledged before it is consumed.
    try {
      this.consume(sub, event);
    } finally {
      void this.send("backend.ack", { subscriptionId: event.subscriptionId, seq: event.seq }).catch(
        (error: unknown) => {
          if (sub.active) this.fail(sub, toCadencrError(error));
        },
      );
    }
  }

  private consume(sub: Subscription, event: EventMap["backend.event"]): void {
    if (event.topic !== sub.topic || event.seq <= sub.seq) return;
    const changed = sub.runId !== null && event.runId !== sub.runId;
    const gap = event.seq > sub.seq + 1;
    sub.seq = event.seq;
    sub.runId = event.runId;
    if (changed || gap) sub.options.onResync?.();
    const { subscriptionId: _, ...data } = event;
    sub.handler(data);
  }

  private async open(sub: Subscription, resync: boolean): Promise<void> {
    this.checkSupport();
    const attempt = ++sub.attempt;
    // Allow socket connection (10s) and native startup (30s), plus relay time.
    const { subscriptionId } = await this.send("backend.subscribe", { topic: sub.topic }, 45_000);
    if (!sub.active) {
      await this.release(subscriptionId);
      throw new CadencrError("DISCONNECTED", "The backend subscription was closed");
    }
    if (attempt !== sub.attempt) return;
    sub.id = subscriptionId;
    sub.seq = 0;
    sub.runId = null;
    this.byId.set(subscriptionId, sub);
    if (resync) sub.options.onResync?.();
  }

  private close(sub: Subscription): void {
    if (!sub.active) return;
    sub.active = false;
    this.subscriptions.delete(sub);
    if (sub.id === null) return;
    this.byId.delete(sub.id);
    void this.release(sub.id).catch((error: unknown) => this.fail(sub, toCadencrError(error)));
  }

  private async release(subscriptionId: string): Promise<void> {
    try {
      await this.send("backend.unsubscribe", { subscriptionId });
    } catch (error) {
      if (error instanceof CadencrError && error.code === "DISCONNECTED") return;
      throw error;
    }
  }

  private fail(sub: Subscription, error: CadencrError): void {
    if (sub.options.onError) sub.options.onError(error);
    else this.reportError(error);
  }
}
