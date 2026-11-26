import { CadencrError, toCadencrError } from "./errors.js";
import type { EventMap, MethodParams } from "./protocol.js";
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

interface Binding {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function binding(): Binding {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  /** Settles once an attempt registered an id on the current connection, or
   *  the subscription failed terminally. */
  bound: Binding;
}

/** Native subscriptions only. Backend methods and event payloads stay opaque. */
export class BackendStreams {
  private readonly subscriptions = new Set<Subscription>();
  private readonly byId = new Map<string, Subscription>();
  /** Bumped when a new host connection replaces the previous one; in-flight
   *  rebinds of the replaced connection are stale against it. */
  private connectionGeneration = 0;

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
      bound: binding(),
    };
    this.subscriptions.add(sub);
    const generation = this.connectionGeneration;
    void this.open(sub, false, generation).catch((error: unknown) => {
      // A newer connection took over while registering: it rebinds this
      // logical subscription, so the failure is transient, not terminal.
      if (!sub.active || generation !== this.connectionGeneration) return;
      sub.bound.reject(error);
    });
    try {
      // Resolves only once an attempt registered an id on the current
      // connection, so a caller starting work right after `await subscribe`
      // does not race the listener setup.
      await sub.bound.promise;
      return { unsubscribe: () => this.close(sub) };
    } catch (error) {
      this.close(sub);
      throw error;
    }
  }

  /** Called when the host delivers a new port: the previous connection's
   *  in-flight rebinds must not close logical subscriptions. */
  connectionReplaced(): void {
    this.connectionGeneration++;
  }

  resubscribeAll(): void {
    const generation = this.connectionGeneration;
    this.byId.clear();
    for (const sub of this.subscriptions) {
      sub.id = null;
      void this.open(sub, true, generation).catch((error: unknown) => {
        // A newer connection replaced this one mid-rebind: the failure is
        // transient and the next successful handshake rebinds the subscription.
        if (!sub.active || generation !== this.connectionGeneration) return;
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
    if (event === "backend.resync") {
      const { subscriptionId, resyncId } = payload as EventMap["backend.resync"];
      try {
        sub.options.onResync?.();
      } finally {
        if (resyncId !== undefined) this.acknowledge(sub, { subscriptionId, resyncId });
      }
    } else if (event === "backend.error") {
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
      this.acknowledge(sub, { subscriptionId: event.subscriptionId, seq: event.seq });
    }
  }

  private acknowledge(sub: Subscription, params: MethodParams<"backend.ack">): void {
    const generation = this.connectionGeneration;
    if (!sub.active || sub.id !== params.subscriptionId) return;
    void this.send("backend.ack", params).catch((error: unknown) => {
      if (sub.active && generation === this.connectionGeneration)
        this.fail(sub, toCadencrError(error));
    });
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

  private async open(
    sub: Subscription,
    resync: boolean,
    generation = this.connectionGeneration,
  ): Promise<void> {
    this.checkSupport();
    const attempt = ++sub.attempt;
    // Allow socket connection (10s) and native startup (30s), plus relay time.
    const { subscriptionId } = await this.send(
      "backend.subscribe",
      { topic: sub.topic, ackResync: true },
      45_000,
    );
    if (!sub.active) {
      await this.release(subscriptionId);
      return;
    }
    if (attempt !== sub.attempt || generation !== this.connectionGeneration) {
      // Superseded by a newer rebind: release what this attempt obtained and
      // let the current generation own the logical subscription.
      await this.release(subscriptionId);
      return;
    }
    sub.id = subscriptionId;
    sub.seq = 0;
    sub.runId = null;
    this.byId.set(subscriptionId, sub);
    sub.bound.resolve();
    if (resync) sub.options.onResync?.();
  }

  private close(sub: Subscription): void {
    if (!sub.active) return;
    sub.active = false;
    this.subscriptions.delete(sub);
    sub.bound.reject(new CadencrError("DISCONNECTED", "The backend subscription was closed"));
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
