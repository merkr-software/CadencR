import {
  METHOD_NAMES,
  PROTOCOL_VERSION,
  SUPPORTED_API_VERSIONS,
  isGuestToHost,
  negotiateApiVersion,
  type EventMap,
  type EventName,
  type GuestToHost,
  type HelloResult,
  type HostToGuest,
  type TabContext,
  type ThemeSnapshot,
} from "@cadencr/tab-sdk/protocol";
import { z } from "zod";

import { BackendFailureWatch, type BackendFailureDeps } from "./broker-backend-failures";
import { BrokerError, badRequest, toWireError } from "./broker-errors";
import { GrantHolder, type GrantDeps } from "./broker-grant";
import { createPluginHttp, type FetchLike } from "./broker-http";
import { DATA_METHODS } from "./broker-methods-data";
import { RUN_METHODS } from "./broker-methods-run";
import { UI_METHODS } from "./broker-methods-ui";
import {
  parseParams,
  type BrokerRuntime,
  type MethodHandler,
  type MethodOutcome,
  type PluginIdentity,
} from "./broker-runtime";
import { PluginStreamSocket, type SocketFactory } from "./broker-streams";
import { subscribePluginTabPorts } from "./port-registry";
import { releasePluginTabInstance, setPluginTabBadge } from "./runtime-store";
import { currentPluginTabTheme, subscribePluginTabTheme } from "./theme-sync";

export interface PluginTabBrokerOptions {
  instanceId: string;
  featureId: number;
  plugin: PluginIdentity;
  context: TabContext;
  visible: boolean;
}

/** Seams for tests; production uses the real service, socket and theme. */
export interface PluginTabBrokerDeps {
  grant?: GrantDeps;
  backendFailures?: BackendFailureDeps;
  fetch?: FetchLike;
  socket?: SocketFactory;
  theme?: () => ThemeSnapshot;
  /** Whether to listen for ports posted to `window` (default true). */
  windowPorts?: boolean;
}

const helloSchema = z.object({
  sdkVersion: z.string(),
  apiVersions: z.tuple([z.number().int(), z.number().int()]),
});

const subscribeSchema = z.object({
  topic: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The host end of one custom tab instance (docs/CUSTOM_TABS.md §7): owns the
 * guest's `MessagePort` (the latest one — a guest reload brings a new port),
 * holds the instance's grant and relays each request to the service, the
 * plugin socket or the app UI. Pushes context, theme and visibility changes.
 */
export class PluginTabBroker {
  private port: MessagePort | null = null;
  private context: TabContext;
  private contextKey: string;
  private visible: boolean;
  private disposed = false;
  private readonly runtime: BrokerRuntime;
  private readonly methods: ReadonlyMap<string, MethodHandler>;
  private readonly theme: () => ThemeSnapshot;
  private readonly cleanups: Array<() => void> = [];
  /** Tells the user when the backend can't run at all; the page still gets the error. */
  private readonly backendFailures: BackendFailureWatch;

  constructor(options: PluginTabBrokerOptions, deps: PluginTabBrokerDeps = {}) {
    this.context = options.context;
    this.contextKey = JSON.stringify(options.context);
    this.visible = options.visible;
    this.theme = deps.theme ?? currentPluginTabTheme;
    this.backendFailures = new BackendFailureWatch(options.instanceId, deps.backendFailures);
    const grant = new GrantHolder(options.plugin.id, options.featureId, deps.grant);
    const streams = new PluginStreamSocket({
      instanceId: options.instanceId,
      grant,
      sink: {
        event: (subscriptionId, seq, data) =>
          this.emit("stream.event", { subscriptionId, seq, data }),
        resync: (subscriptionId) => this.emit("stream.resync", { subscriptionId }),
        error: (subscriptionId, error) => this.emit("stream.error", { subscriptionId, error }),
      },
      createSocket: deps.socket,
    });
    this.runtime = {
      instanceId: options.instanceId,
      plugin: options.plugin,
      grant,
      http: createPluginHttp(grant, deps.fetch),
      streams,
    };
    // A Map, not an object: a guest naming `constructor` or `toString` must
    // not reach an Object.prototype function.
    this.methods = new Map(
      Object.entries({
        ...DATA_METHODS,
        ...RUN_METHODS,
        ...UI_METHODS,
        ...this.streamMethods(),
      }),
    );
    if (deps.windowPorts !== false) {
      this.cleanups.push(
        subscribePluginTabPorts(options.instanceId, (port) => this.attachPort(port)),
      );
    }
    this.cleanups.push(subscribePluginTabTheme((theme) => this.emit("theme.changed", { theme })));
  }

  get instanceId(): string {
    return this.runtime.instanceId;
  }

  /** Adopt the guest's newest port; the previous one (a reloaded page) is closed. */
  attachPort(port: MessagePort): void {
    if (this.disposed) {
      port.close();
      return;
    }
    this.detachPort();
    // A new port is a new page: the previous page's subscriptions are dead.
    this.runtime.streams.reset();
    this.port = port;
    port.onmessage = (event: MessageEvent) => {
      if (this.port === port) void this.handleMessage(port, event.data);
    };
  }

  /** Name/version/origins/levels after a manifest change (hot reload). */
  setPlugin(plugin: PluginIdentity): void {
    this.runtime.plugin = plugin;
  }

  /** Pushes `context.changed` only when the context actually differs. */
  setContext(context: TabContext): void {
    const key = JSON.stringify(context);
    if (key === this.contextKey) return;
    this.context = context;
    this.contextKey = key;
    this.emit("context.changed", { context });
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.emit("visibility.changed", { visible });
  }

  /** One of the tab's active shortcuts was pressed while it had focus. */
  pressShortcut(id: string): void {
    if (this.runtime.plugin.shortcuts.includes(id)) this.emit("shortcut", { id });
  }

  /** The grant was revoked server-side (hot reload): mint a fresh one on next use. */
  resetGrant(): void {
    this.runtime.grant.invalidate();
  }

  /**
   * The guest page is gone (recycled under the live-guest cap, crashed, or
   * failed to load): close its port, drop its socket and subscriptions and
   * revoke its grant, so a dead guest holds nothing. The broker stays usable:
   * the recreated page brings a new port and a fresh `hello`, and the grant
   * and socket come back on first use.
   */
  suspend(): void {
    if (this.disposed) return;
    this.detachPort();
    this.runtime.streams.reset();
    this.runtime.grant.release();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.detachPort();
    this.runtime.streams.dispose();
    this.runtime.grant.dispose();
    this.backendFailures.dispose();
    releasePluginTabInstance(this.instanceId);
    setPluginTabBadge(this.instanceId, null);
  }

  private detachPort(): void {
    const previous = this.port;
    this.port = null;
    if (!previous) return;
    previous.onmessage = null;
    previous.close();
  }

  private async handleMessage(port: MessagePort, data: unknown): Promise<void> {
    if (!isGuestToHost(data)) return;
    try {
      const outcome = await this.dispatch(data);
      if (data.method === "backend.request") this.backendFailures.answered();
      this.post(
        port,
        { v: PROTOCOL_VERSION, kind: "response", id: data.id, result: outcome.result },
        outcome.transfer,
      );
    } catch (error) {
      if (data.method === "backend.request" && !this.disposed) {
        this.backendFailures.failed(this.runtime.plugin.name, error);
      }
      this.post(port, {
        v: PROTOCOL_VERSION,
        kind: "response",
        id: data.id,
        error: toWireError(error),
      });
    }
  }

  private dispatch(request: GuestToHost): Promise<MethodOutcome> {
    if (request.method === "hello") return this.hello(request.params);
    const handler = this.methods.get(request.method);
    if (!handler) return Promise.reject(badRequest(`Unknown method: ${request.method}`));
    return handler(request.params, this.runtime);
  }

  /** Stateless, so a repeated hello on the same port (StrictMode) just answers again. */
  private async hello(params: unknown): Promise<MethodOutcome> {
    const { apiVersions } = parseParams(helloSchema, params, "hello");
    const apiVersion = negotiateApiVersion(apiVersions);
    if (apiVersion === null) {
      throw new BrokerError(
        "PLUGIN_API_UNSUPPORTED",
        `This Cadencr speaks plugin API v${SUPPORTED_API_VERSIONS[0]}–v${SUPPORTED_API_VERSIONS[1]}; the tab asked for v${apiVersions[0]}–v${apiVersions[1]}`,
        { supported: SUPPORTED_API_VERSIONS },
      );
    }
    const result: HelloResult = {
      apiVersion,
      instanceId: this.instanceId,
      plugin: { id: this.runtime.plugin.id, version: this.runtime.plugin.version },
      context: this.context,
      theme: this.theme(),
      capabilities: await this.capabilities(),
      // A page recreated while hidden (a rebuild) gets no visibility change.
      visible: this.visible,
      shortcuts: [...this.runtime.plugin.shortcuts],
    };
    return { result };
  }

  /** Every method this tab may use, plus the scopes the grant carries. */
  private async capabilities(): Promise<string[]> {
    const plugin = this.runtime.plugin;
    const declared: Partial<Record<string, boolean>> = {
      hello: false,
      "net.fetch": plugin.allowedOrigins.length > 0,
      "exec.run": plugin.hasCommands,
      "backend.request": plugin.hasBackend,
    };
    const methods = METHOD_NAMES.filter((method) => declared[method] ?? true);
    try {
      return [...methods, ...(await this.runtime.grant.get()).scopes];
    } catch {
      // No grant (the tab is off for this project): the handshake still
      // succeeds, and each API call reports the actual refusal.
      return methods;
    }
  }

  private streamMethods(): Record<string, MethodHandler> {
    return {
      "streams.subscribe": async (params, runtime) => {
        const { topic, params: topicParams } = parseParams(
          subscribeSchema,
          params,
          "streams.subscribe",
        );
        return { result: { subscriptionId: await runtime.streams.subscribe(topic, topicParams) } };
      },
      "streams.unsubscribe": async (params, runtime) => {
        const { subscriptionId } = parseParams(
          z.object({ subscriptionId: z.string() }),
          params,
          "streams.unsubscribe",
        );
        runtime.streams.unsubscribe(subscriptionId);
        return { result: null };
      },
    };
  }

  private emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    if (this.port) this.post(this.port, { v: PROTOCOL_VERSION, kind: "event", event, payload });
  }

  private post(port: MessagePort, message: HostToGuest, transfer?: Transferable[]): void {
    if (this.disposed || this.port !== port) return;
    port.postMessage(message, transfer ?? []);
  }
}
