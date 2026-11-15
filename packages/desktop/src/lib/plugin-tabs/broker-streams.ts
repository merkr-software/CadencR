import type { StreamEnvelope, WireError } from "@cadencr/tab-sdk/protocol";

import type { WebSocketLike, WsConnection } from "@/lib/ws-connection";
import { createEnvelope, parseEnvelope, type WsEnvelope } from "@/lib/ws-envelope";
import {
  openLifecycleSocket,
  WS_CLOSE_NORMAL,
  WS_CLOSE_POLICY_VIOLATION,
  type SocketDrop,
} from "@/lib/ws-lifecycle";
import { clearReconnect, scheduleReconnect } from "@/lib/ws-reconnect";
import { getPluginTabWsUrl } from "@/lib/ws-url";

import { BrokerError, toBrokerError } from "./broker-errors";
import type { GrantHolder } from "./broker-grant";

export interface StreamSink {
  event(subscriptionId: string, seq: number, data: StreamEnvelope): void;
  resync(subscriptionId: string): void;
  error(subscriptionId: string, error: WireError): void;
}

export type SocketFactory = (url: string, protocol: string) => WebSocketLike;

export interface PluginStreamSocketOptions {
  /** Owning instance; keys the socket's shared reconnect backoff. */
  instanceId: string;
  grant: GrantHolder;
  sink: StreamSink;
  createSocket?: SocketFactory;
  url?: () => string;
}

interface Subscription {
  topic: string;
  params?: Record<string, unknown>;
  /** The server's id on the current socket; `null` until (re)subscribed. */
  serverId: string | null;
  /** A `subscribe` for it is in flight (so a reconnect must not send another). */
  binding: boolean;
  /**
   * The guest's `seq` stays increasing across reconnects: a re-made server
   * subscription counts from 1 again, so its events are shifted past the
   * last one forwarded (`seqBase`) rather than read as duplicates.
   */
  seqBase: number;
  lastSeq: number;
}

interface PendingReply {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: BrokerError) => void;
}

const defaultSocketFactory: SocketFactory = (url, protocol) => new WebSocket(url, [protocol]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * The instance's plugin socket (§4.4), opened on the first subscription and
 * closed when the last one goes. Subscription ids handed to the guest are
 * local and stable: after a reconnect every live subscription is re-made on
 * the new socket and the guest gets `stream.resync` (events were lost
 * meanwhile), and its `seq` carries on from where it was. Connection, drop
 * and retry follow the shared socket lifecycle (`lib/ws-lifecycle`); a custom
 * tab's stream does not speak for backend reachability, so it is not reported
 * in the connection status.
 */
export class PluginStreamSocket {
  private socket: WsConnection | null = null;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly byServerId = new Map<string, string>();
  private readonly pending = new Map<string, PendingReply>();
  private nextLocalId = 1;
  private opening: Promise<WsConnection> | null = null;
  /**
   * Fails the socket still opening. Its own close is intentional, so the
   * lifecycle reports nothing for it: without this, `opening` would never
   * settle and no later subscribe could open a socket again.
   */
  private abortOpening: ((error: BrokerError) => void) | null = null;
  private disposed = false;
  private readonly reconnectKey: string;
  private readonly grant: GrantHolder;
  private readonly sink: StreamSink;
  private readonly createSocket: SocketFactory;
  private readonly url: () => string;

  constructor(options: PluginStreamSocketOptions) {
    this.reconnectKey = `plugin-tab:${options.instanceId}`;
    this.grant = options.grant;
    this.sink = options.sink;
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.url = options.url ?? getPluginTabWsUrl;
  }

  async subscribe(topic: string, params?: Record<string, unknown>): Promise<string> {
    const localId = `s${this.nextLocalId++}`;
    const subscription: Subscription = {
      topic,
      params,
      serverId: null,
      binding: true,
      seqBase: 0,
      lastSeq: 0,
    };
    this.subscriptions.set(localId, subscription);
    try {
      await this.bind(localId, subscription, await this.open());
      return localId;
    } catch (error) {
      this.subscriptions.delete(localId);
      throw error;
    } finally {
      subscription.binding = false;
    }
  }

  unsubscribe(localId: string): void {
    const subscription = this.subscriptions.get(localId);
    if (!subscription) return;
    this.subscriptions.delete(localId);
    if (subscription.serverId !== null) {
      this.byServerId.delete(subscription.serverId);
      if (this.socket?.isOpen()) {
        this.send(this.socket, "unsubscribe", { subscription_id: subscription.serverId });
      }
    }
    // Nothing left to stream: don't keep an idle authenticated socket open.
    if (this.subscriptions.size === 0 && this.opening === null) this.closeSocket();
  }

  /**
   * Drop every subscription and the socket (the guest page was reloaded or
   * is gone: a new page subscribes afresh). The socket reopens on the next
   * subscribe.
   */
  reset(): void {
    clearReconnect(this.reconnectKey);
    this.rejectPending("The custom tab was reloaded");
    this.subscriptions.clear();
    this.byServerId.clear();
    this.closeSocket();
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private closeSocket(): void {
    const socket = this.socket;
    const abort = this.abortOpening;
    this.socket = null;
    this.abortOpening = null;
    abort?.(new BrokerError("DISCONNECTED", "The plugin socket was closed"));
    socket?.close(WS_CLOSE_NORMAL);
  }

  private open(): Promise<WsConnection> {
    if (this.socket?.isOpen()) return Promise.resolve(this.socket);
    this.opening ??= this.connect().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connect(): Promise<WsConnection> {
    const token = await this.grant.token();
    if (this.disposed) throw new BrokerError("DISCONNECTED", "The custom tab was closed");
    return new Promise<WsConnection>((resolve, reject) => {
      this.abortOpening = reject;
      const socket = openLifecycleSocket({
        key: this.reconnectKey,
        url: this.url(),
        protocols: [`cadencr-plugin.${token}`],
        createSocket: (url, protocols) => this.createSocket(url, protocols?.[0] ?? ""),
        isCurrent: (connection) => this.socket === connection,
        onConnected: (connection) => {
          this.abortOpening = null;
          resolve(connection);
        },
        // Subscriptions a drop left unbound come back with this socket; each
        // rebind tells the guest to resync (`rebind`).
        replay: () => void this.resubscribeAll(),
        onMessage: (data) => this.handleMessage(data),
        onDrop: (drop) => {
          this.abortOpening = null;
          reject(new BrokerError("DISCONNECTED", "The plugin socket closed"));
          this.handleDrop(drop, token);
        },
        shouldRetry: () => this.canRetry(),
        reconnect: this.retry,
      });
      this.socket = socket;
    });
  }

  private async bind(localId: string, subscription: Subscription, socket: WsConnection) {
    subscription.binding = true;
    try {
      const reply = await this.request(socket, "subscribe", {
        topic: subscription.topic,
        params: subscription.params ?? {},
      });
      const serverId = reply.subscription_id;
      if (typeof serverId !== "string") {
        throw new BrokerError("HOST_ERROR", "The plugin socket answered without a subscription id");
      }
      // Unsubscribed while the reply was in flight: release it server-side.
      if (this.subscriptions.get(localId) !== subscription) {
        this.send(socket, "unsubscribe", { subscription_id: serverId });
        return;
      }
      subscription.serverId = serverId;
      subscription.seqBase = subscription.lastSeq;
      this.byServerId.set(serverId, localId);
    } finally {
      subscription.binding = false;
    }
  }

  private request(
    socket: WsConnection,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.send(socket, action, payload);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private send(socket: WsConnection, action: string, payload: Record<string, unknown>): string {
    const envelope = createEnvelope("plugin", action, payload);
    socket.sendJson(envelope);
    return envelope.id;
  }

  private handleMessage(raw: string): void {
    let message: WsEnvelope;
    try {
      message = parseEnvelope(raw);
    } catch {
      // Not an envelope: the service only ever sends envelope text frames.
      return;
    }
    const payload = asRecord(message.payload);
    if (message.action === "event") {
      this.forwardEvent(payload);
      return;
    }
    if (message.action === "resync") {
      // The service's source lagged and dropped events for this subscription.
      const localId = this.byServerId.get(String(payload.subscription_id));
      if (localId !== undefined) this.sink.resync(localId);
      return;
    }
    const reply = message.ref === undefined ? undefined : this.pending.get(message.ref);
    if (!reply || message.ref === undefined) return;
    this.pending.delete(message.ref);
    if (message.action === "subscribed") {
      reply.resolve(payload);
      return;
    }
    const code = typeof payload.code === "string" ? payload.code : "HOST_ERROR";
    const text = typeof payload.message === "string" ? payload.message : "Subscription refused";
    reply.reject(new BrokerError(code, text));
  }

  private forwardEvent(payload: Record<string, unknown>): void {
    const localId = this.byServerId.get(String(payload.subscription_id));
    const subscription = localId === undefined ? undefined : this.subscriptions.get(localId);
    if (localId === undefined || !subscription) return;
    const envelope = asRecord(payload.envelope);
    const seq = subscription.seqBase + (typeof payload.seq === "number" ? payload.seq : 0);
    subscription.lastSeq = Math.max(subscription.lastSeq, seq);
    this.sink.event(localId, seq, {
      domain: String(envelope.domain ?? ""),
      action: String(envelope.action ?? ""),
      payload: envelope.payload ?? null,
    });
  }

  private handleDrop(drop: SocketDrop, token: string): void {
    this.socket = null;
    this.rejectPending("The plugin socket closed");
    this.byServerId.clear();
    for (const subscription of this.subscriptions.values()) subscription.serverId = null;
    // A revoked or expired grant: the service closes an open socket with
    // 1008, and refuses the upgrade (a drop before open) to a dead token.
    // Either way the retry reconnects with a fresh grant.
    if (drop.code === WS_CLOSE_POLICY_VIOLATION || !drop.opened) this.grant.invalidate(token);
  }

  /** Only live subscriptions are worth a socket. */
  private canRetry(): boolean {
    return !this.disposed && this.subscriptions.size > 0;
  }

  private readonly retry = (): void => void this.resubscribeAll();

  /** Same backoff as a drop; a no-op while a retry is already pending. */
  private retryLater(): void {
    if (this.canRetry()) scheduleReconnect(this.reconnectKey, this.retry);
  }

  /** Subscriptions with no server id and no `subscribe` in flight. */
  private unbound(): Array<[string, Subscription]> {
    return [...this.subscriptions].filter(
      ([, subscription]) => subscription.serverId === null && !subscription.binding,
    );
  }

  /**
   * Re-make every unbound subscription on the (re)opened socket. Idempotent:
   * a subscription already bound — or being bound by `subscribe` — is skipped,
   * so a reconnect racing a fresh subscribe never binds one twice.
   */
  private async resubscribeAll(): Promise<void> {
    if (this.disposed || this.unbound().length === 0) return;
    let socket: WsConnection;
    try {
      socket = await this.open();
    } catch {
      // The grant could not be minted, or the socket dropped before opening
      // (the lifecycle already scheduled that retry): try again later.
      this.retryLater();
      return;
    }
    await Promise.allSettled(
      this.unbound().map(([localId, subscription]) => this.rebind(localId, subscription, socket)),
    );
  }

  private async rebind(localId: string, subscription: Subscription, socket: WsConnection) {
    try {
      await this.bind(localId, subscription, socket);
      if (this.subscriptions.get(localId) === subscription) this.sink.resync(localId);
    } catch (error) {
      // Dropped again: the next reconnect retries it.
      if (this.socket !== socket || this.subscriptions.get(localId) !== subscription) return;
      this.subscriptions.delete(localId);
      const failure = toBrokerError(error);
      this.sink.error(localId, { code: failure.code, message: failure.message });
    }
  }

  private rejectPending(message: string): void {
    for (const reply of this.pending.values())
      reply.reject(new BrokerError("DISCONNECTED", message));
    this.pending.clear();
  }
}
