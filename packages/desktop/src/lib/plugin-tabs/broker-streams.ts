import type { StreamEnvelope, WireError } from "@cadencr/tab-sdk/protocol";

import { createEnvelope, parseEnvelope, type WsEnvelope } from "@/lib/ws-envelope";
import {
  clearReconnect,
  resetReconnectState,
  scheduleReconnect as scheduleSocketReconnect,
} from "@/lib/ws-reconnect";
import { getPluginTabWsUrl } from "@/lib/ws-url";

import { BrokerError, toBrokerError } from "./broker-errors";
import type { GrantHolder } from "./broker-grant";
import { asRecord, socketEventPayload, subscriptionPayload } from "./broker-stream-messages";
import { SocketRequests } from "./broker-socket-requests";

/** Close code the service uses when a grant is revoked or expires. */
const POLICY_VIOLATION = 1008;
const NORMAL_CLOSURE = 1000;
const OPEN = 1;

export interface StreamSink {
  event(subscriptionId: string, seq: number, data: StreamEnvelope): void;
  resync(subscriptionId: string): void;
  error(subscriptionId: string, error: WireError): void;
}

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
}

export type SocketFactory = (url: string, protocol: string) => SocketLike;

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

const defaultSocketFactory: SocketFactory = (url, protocol) => new WebSocket(url, [protocol]);

/**
 * The instance's plugin socket (§4.4), opened on the first subscription and
 * closed when the last one goes. Subscription ids handed to the guest are
 * local and stable: after a reconnect every live subscription is re-made on
 * the new socket and the guest gets `stream.resync` (events were lost
 * meanwhile), and its `seq` carries on from where it was. Reconnects share the app's backoff (`lib/ws-reconnect`).
 */
export class PluginStreamSocket {
  private socket: SocketLike | null = null;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly byServerId = new Map<string, string>();
  private readonly requests = new SocketRequests();
  private nextLocalId = 1;
  private activeCalls = 0;
  private generation = 0;
  private opening: Promise<SocketLike> | null = null;
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

  async subscribe(
    topic: string,
    params?: Record<string, unknown>,
    backend = false,
  ): Promise<string> {
    const localId = `${backend ? "b" : "s"}${this.nextLocalId++}`;
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
      this.closeIfIdle();
    }
  }

  /** One attempt only. A disconnect or timeout never replays a backend method. */
  async backendRequest(
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    this.activeCalls++;
    try {
      return await this.requests.send(await this.open(), "backend.request", payload, timeoutMs);
    } finally {
      this.activeCalls--;
      this.closeIfIdle();
    }
  }

  unsubscribe(localId: string): void {
    const subscription = this.subscriptions.get(localId);
    if (!subscription) return;
    this.subscriptions.delete(localId);
    if (subscription.serverId !== null) {
      this.byServerId.delete(subscription.serverId);
      if (this.socket?.readyState === OPEN) {
        this.send(this.socket, "unsubscribe", { subscription_id: subscription.serverId });
      }
    }
    // Nothing left to stream: don't keep an idle authenticated socket open.
    this.closeIfIdle();
  }

  /**
   * Drop every subscription and the socket (the guest page was reloaded or
   * is gone: a new page subscribes afresh). The socket reopens on the next
   * subscribe.
   */
  reset(): void {
    this.generation++;
    clearReconnect(this.reconnectKey);
    this.requests.rejectAll("The custom tab was reloaded");
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
    this.socket = null;
    socket?.close(NORMAL_CLOSURE);
  }

  private open(): Promise<SocketLike> {
    if (this.socket?.readyState === OPEN) return Promise.resolve(this.socket);
    this.opening ??= this.connect().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connect(): Promise<SocketLike> {
    const generation = this.generation;
    const token = await this.grant.token();
    if (this.disposed || generation !== this.generation)
      throw new BrokerError("DISCONNECTED", "The custom tab was closed or reloaded");
    const socket = this.createSocket(this.url(), `cadencr-plugin.${token}`);
    this.socket = socket;
    let opened = false;
    return new Promise<SocketLike>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new BrokerError("TIMEOUT", "The plugin socket did not open"));
        socket.close();
      }, 10_000);
      socket.onopen = () => {
        clearTimeout(timer);
        if (this.socket !== socket) {
          reject(new BrokerError("DISCONNECTED", "The plugin socket was replaced"));
          socket.close();
          return;
        }
        opened = true;
        resetReconnectState(this.reconnectKey);
        resolve(socket);
        // Subscriptions a drop left unbound come back with this socket.
        void this.resubscribeAll();
      };
      socket.onmessage = (event) => {
        if (this.socket === socket) this.handleMessage(event.data);
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        reject(new BrokerError("DISCONNECTED", "The plugin socket closed"));
        this.handleClose(socket, { code: event.code, token, opened });
      };
    });
  }

  private async bind(localId: string, subscription: Subscription, socket: SocketLike) {
    subscription.binding = true;
    try {
      const reply = await this.requests.send(socket, "subscribe", {
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

  private send(socket: SocketLike, action: string, payload: Record<string, unknown>): string {
    const envelope = createEnvelope("plugin", action, payload);
    socket.send(JSON.stringify(envelope));
    return envelope.id;
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: WsEnvelope;
    try {
      message = parseEnvelope(raw);
    } catch {
      // Not an envelope: the service only ever sends envelope text frames.
      return;
    }
    const payload = asRecord(message.payload);
    if (message.domain !== "plugin") return;
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
    if (this.requests.handle(message)) return;
    if (message.action === "error") {
      const parsed = subscriptionPayload.safeParse(payload);
      const localId = parsed.success ? this.byServerId.get(parsed.data.subscription_id) : undefined;
      if (localId !== undefined)
        this.sink.error(localId, {
          code: String(payload.code ?? "HOST_ERROR"),
          message: String(payload.message ?? "Stream failed"),
        });
    }
  }

  private forwardEvent(payload: Record<string, unknown>): void {
    const parsed = socketEventPayload.safeParse(payload);
    if (!parsed.success) return;
    payload = parsed.data;
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

  private handleClose(
    socket: SocketLike,
    close: { code: number; token: string; opened: boolean },
  ): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.requests.rejectAll("The plugin socket closed");
    this.byServerId.clear();
    for (const subscription of this.subscriptions.values()) subscription.serverId = null;
    // A revoked or expired grant: the service closes an open socket with
    // 1008, and refuses the upgrade (a close before open, 1006) to a dead
    // token. Either way reconnect with a fresh grant.
    if (close.code === POLICY_VIOLATION || !close.opened) this.grant.invalidate(close.token);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.subscriptions.size === 0) return;
    scheduleSocketReconnect(this.reconnectKey, () => void this.resubscribeAll());
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
    let socket: SocketLike;
    try {
      socket = await this.open();
    } catch {
      // The grant could not be minted or the socket dropped before opening
      // (that path already scheduled one): try again later.
      this.scheduleReconnect();
      return;
    }
    await Promise.allSettled(
      this.unbound().map(([localId, subscription]) => this.rebind(localId, subscription, socket)),
    );
  }

  private async rebind(localId: string, subscription: Subscription, socket: SocketLike) {
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

  private closeIfIdle(): void {
    if (this.subscriptions.size === 0 && this.activeCalls === 0 && this.opening === null)
      this.closeSocket();
  }
}
