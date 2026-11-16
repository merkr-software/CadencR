import { Emitter } from "../emitter.js";
import { CadencrError, toCadencrError } from "../errors.js";
import {
  PROTOCOL_VERSION,
  SUPPORTED_API_VERSIONS,
  isGuestToHost,
  type ApiRequestParams,
  type ApiVersionRange,
  type EventMap,
  type EventName,
  type HostToGuest,
  type HttpMethod,
  type JsonValue,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type StreamEnvelope,
  type TabContext,
  type ThemeSnapshot,
  type WireError,
  type WireHttpResponse,
} from "../protocol.js";
import type { PortSource } from "../transport.js";
import { createDefaultHandlers, type HostState } from "./defaults.js";
import { DEFAULT_TEST_CONTEXT, DEFAULT_TEST_THEME } from "./fixtures.js";

export interface RecordedRequest {
  id: string;
  method: string;
  params: unknown;
}

export type MethodHandler<M extends MethodName> = (
  params: MethodParams<M>,
  request: RecordedRequest,
) => MethodResult<M> | Promise<MethodResult<M>>;

export type ApiRouteHandler = (
  request: ApiRequestParams,
) => WireHttpResponse | Promise<WireHttpResponse>;

export interface TestHostOptions {
  context?: TabContext;
  theme?: ThemeSnapshot;
  capabilities?: string[];
  /** Whether the tab starts shown. Default: true. */
  visible?: boolean;
  /** The active manifest shortcut ids `hello` reports. Default: none. */
  shortcuts?: string[];
  instanceId?: string;
  plugin?: { id: string; version: string };
  /** API versions the fake host accepts. Default: the SDK's own range. */
  apiVersions?: ApiVersionRange;
  config?: Record<string, unknown>;
  storage?: Record<string, JsonValue>;
}

export interface TestHost {
  /** Pass to `connect({ transport })`. Delivers the current guest port and,
   *  after `reconnect()`, the new one. */
  readonly transport: PortSource;
  /** The guest end of the current channel. */
  readonly port: MessagePort;
  /** Every request received, in order. */
  readonly requests: readonly RecordedRequest[];
  /** Live subscriptions by id. */
  readonly subscriptions: ReadonlyMap<string, { topic: string; params?: Record<string, unknown> }>;
  readonly storage: Map<string, JsonValue>;
  readonly state: { value: JsonValue };
  readonly badge: string | null;
  readonly context: TabContext;
  readonly theme: ThemeSnapshot;
  /** Replaces the handler for `method`. Throw a `CadencrError` to answer with
   *  an error response. */
  handle<M extends MethodName>(method: M, handler: MethodHandler<M>): void;
  /** Answers `api.request` for `method path` (exact path match). */
  route(method: HttpMethod, path: string, response: ApiRouteHandler | WireHttpResponse): void;
  setContext(context: TabContext): void;
  setTheme(theme: ThemeSnapshot): void;
  setVisible(visible: boolean): void;
  /** Sends `shortcut`, as when the user presses the manifest shortcut `id`. */
  pressShortcut(id: string): void;
  emit<E extends EventName>(event: E, payload: EventMap[E]): void;
  /** Sends `stream.event` to one subscription id, or to every subscription of
   *  a topic. `seq` auto-increments per subscription unless given. */
  pushStream(target: string, data: StreamEnvelope, options?: { seq?: number }): void;
  resync(subscriptionId: string): void;
  streamError(subscriptionId: string, error: WireError): void;
  /** Resolves with the next request (optionally of one method). */
  nextRequest(method?: MethodName): Promise<RecordedRequest>;
  /** Simulates a host reload: a new channel, delivered through `transport`. */
  reconnect(): void;
  /** Simulates port loss: closes the host end. */
  disconnect(): void;
  close(): void;
}

type AnyHandler = (params: unknown, request: RecordedRequest) => unknown;

class FakeHost implements TestHost {
  readonly requests: RecordedRequest[] = [];
  readonly transport: PortSource;
  private readonly host: HostState;
  private readonly handlers: Map<string, AnyHandler>;
  private readonly waiters: { method?: string; resolve(request: RecordedRequest): void }[] = [];
  private readonly ports = new Emitter<MessagePort>();
  private channel = new MessageChannel();

  constructor(options: TestHostOptions) {
    this.host = {
      context: options.context ?? DEFAULT_TEST_CONTEXT,
      theme: options.theme ?? DEFAULT_TEST_THEME,
      capabilities: options.capabilities ?? [],
      visible: options.visible ?? true,
      shortcuts: options.shortcuts ?? [],
      instanceId: options.instanceId ?? "test-instance",
      plugin: options.plugin ?? { id: "test-tab", version: "0.0.0" },
      apiVersions: options.apiVersions ?? SUPPORTED_API_VERSIONS,
      config: options.config ?? {},
      storage: new Map(Object.entries(options.storage ?? {})),
      instanceState: { value: null },
      badge: null,
      routes: new Map(),
      subscriptions: new Map(),
      seqs: new Map(),
      subscriptionCounter: 0,
    };
    this.handlers = new Map(
      Object.entries(createDefaultHandlers(this.host)) as [string, AnyHandler][],
    );
    this.transport = {
      subscribe: (listener) => {
        const off = this.ports.on(listener);
        listener(this.channel.port2);
        return off;
      },
    };
    this.open();
  }

  get port(): MessagePort {
    return this.channel.port2;
  }
  get subscriptions(): ReadonlyMap<string, { topic: string; params?: Record<string, unknown> }> {
    return this.host.subscriptions;
  }
  get storage(): Map<string, JsonValue> {
    return this.host.storage;
  }
  get state(): { value: JsonValue } {
    return this.host.instanceState;
  }
  get badge(): string | null {
    return this.host.badge;
  }
  get context(): TabContext {
    return this.host.context;
  }
  get theme(): ThemeSnapshot {
    return this.host.theme;
  }

  handle<M extends MethodName>(method: M, handler: MethodHandler<M>): void {
    this.handlers.set(method, handler as AnyHandler);
  }

  route(method: HttpMethod, path: string, response: ApiRouteHandler | WireHttpResponse): void {
    this.host.routes.set(
      `${method} ${path}`,
      typeof response === "function" ? response : () => response,
    );
  }

  setContext(context: TabContext): void {
    this.host.context = context;
    this.emit("context.changed", { context });
  }

  setTheme(theme: ThemeSnapshot): void {
    this.host.theme = theme;
    this.emit("theme.changed", { theme });
  }

  setVisible(visible: boolean): void {
    this.host.visible = visible;
    this.emit("visibility.changed", { visible });
  }

  pressShortcut(id: string): void {
    this.emit("shortcut", { id });
  }

  emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    this.send({ v: PROTOCOL_VERSION, kind: "event", event, payload });
  }

  pushStream(target: string, data: StreamEnvelope, options: { seq?: number } = {}): void {
    const { subscriptions, seqs } = this.host;
    const ids = subscriptions.has(target)
      ? [target]
      : [...subscriptions].filter(([, sub]) => sub.topic === target).map(([id]) => id);
    for (const subscriptionId of ids) {
      const seq = options.seq ?? (seqs.get(subscriptionId) ?? 0) + 1;
      seqs.set(subscriptionId, seq);
      this.emit("stream.event", { subscriptionId, seq, data });
    }
  }

  resync(subscriptionId: string): void {
    this.emit("stream.resync", { subscriptionId });
  }

  streamError(subscriptionId: string, error: WireError): void {
    this.emit("stream.error", { subscriptionId, error });
  }

  nextRequest(method?: MethodName): Promise<RecordedRequest> {
    return new Promise((resolve) => this.waiters.push({ method, resolve }));
  }

  reconnect(): void {
    const previous = this.channel;
    previous.port1.removeEventListener("message", this.onMessage);
    this.host.subscriptions.clear();
    this.host.seqs.clear();
    this.channel = new MessageChannel();
    this.open();
    previous.port1.close();
  }

  disconnect(): void {
    this.channel.port1.removeEventListener("message", this.onMessage);
    this.host.subscriptions.clear();
    this.channel.port1.close();
  }

  close(): void {
    this.ports.clear();
    this.disconnect();
  }

  private open(): void {
    this.channel.port1.addEventListener("message", this.onMessage);
    this.channel.port1.start();
    this.ports.emit(this.channel.port2);
  }

  private send(message: HostToGuest): void {
    this.channel.port1.postMessage(message);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (!isGuestToHost(event.data)) return;
    const request = { id: event.data.id, method: event.data.method, params: event.data.params };
    this.requests.push(request);
    for (const waiter of [...this.waiters]) {
      if (waiter.method !== undefined && waiter.method !== request.method) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(request);
    }
    void this.answer(request);
  };

  private async answer(request: RecordedRequest): Promise<void> {
    const handler = this.handlers.get(request.method);
    try {
      if (!handler) throw new CadencrError("NOT_FOUND", `Unknown method ${request.method}`);
      const result = await handler(request.params, request);
      this.send({ v: PROTOCOL_VERSION, kind: "response", id: request.id, result: result ?? null });
    } catch (error) {
      const wire = toCadencrError(error).toWire();
      this.send({ v: PROTOCOL_VERSION, kind: "response", id: request.id, error: wire });
    }
  }
}

/** A fake Cadencr host on a standard `MessageChannel`, for unit tests. */
export function createTestHost(options: TestHostOptions = {}): TestHost {
  return new FakeHost(options);
}
