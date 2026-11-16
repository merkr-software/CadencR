import { createApi, type CadencrApi } from "./api.js";
import { Connection } from "./connection.js";
import { Emitter } from "./emitter.js";
import { CadencrError } from "./errors.js";
import { createBackend, createExec, type CadencrBackend, type CadencrExec } from "./execution.js";
import { releaseDefaultClient } from "./fetcher.js";
import {
  createConfig,
  createNet,
  createState,
  createStorage,
  createUi,
  type CadencrConfig,
  type CadencrNet,
  type CadencrState,
  type CadencrStorage,
  type CadencrUi,
} from "./namespaces.js";
import type {
  EventMap,
  HelloResult,
  MethodName,
  MethodParams,
  MethodResult,
  TabContext,
  ThemeSnapshot,
} from "./protocol.js";
import type { Requester } from "./requester.js";
import { StreamRegistry, type CadencrStreams } from "./streams.js";
import { applyTheme } from "./theme.js";
import type { PortSource } from "./transport.js";

export interface ClientOptions {
  source: PortSource;
  requestTimeoutMs: number;
  handshakeTimeoutMs: number;
  applyTheme: boolean;
}

export interface CadencrCapabilities {
  readonly list: readonly string[];
  isSupported(name: string): boolean;
}

/** A connected custom tab. Create one with `connect()`. */
export class CadencrClient {
  readonly api: CadencrApi;
  readonly streams: CadencrStreams;
  readonly storage: CadencrStorage;
  readonly state: CadencrState;
  readonly config: CadencrConfig;
  readonly net: CadencrNet;
  /** The programs listed in `tab.json` `commands`; see `capabilities`. */
  readonly exec: CadencrExec;
  /** The tab's native `backend`, when it declares one. */
  readonly backend: CadencrBackend;
  readonly ui: CadencrUi;
  readonly capabilities: CadencrCapabilities;

  private hello: HelloResult | null = null;
  private isVisible = true;
  private readonly connection: Connection;
  private readonly registry: StreamRegistry;
  private readonly contextChanges = new Emitter<TabContext>();
  private readonly themeChanges = new Emitter<ThemeSnapshot>();
  private readonly visibilityChanges = new Emitter<boolean>();
  private readonly shortcutPresses = new Emitter<string>();
  private readonly connectionChanges = new Emitter<boolean>();
  private readonly errors = new Emitter<CadencrError>();

  /** @internal Use `connect()`. */
  constructor(private readonly options: ClientOptions) {
    this.connection = new Connection(
      options.source,
      {
        requestTimeoutMs: options.requestTimeoutMs,
        handshakeTimeoutMs: options.handshakeTimeoutMs,
      },
      {
        onReady: (hello, reconnected) => this.onReady(hello, reconnected),
        onEvent: (event, payload) => this.onEvent(event, payload),
        onConnectionChange: (connected) => this.connectionChanges.emit(connected),
        onError: (error) => this.reportError(error),
      },
    );
    const send: Requester = (method, params, timeoutMs) =>
      this.connection.request(method, params, timeoutMs);
    this.registry = new StreamRegistry(send, (error) => this.reportError(error));
    this.streams = this.registry;
    this.api = createApi(send);
    this.storage = createStorage(send);
    this.state = createState(send);
    this.config = createConfig(send);
    this.net = createNet(send);
    this.exec = createExec(send);
    this.backend = createBackend(send);
    this.ui = createUi(send);
    const capabilities = (): readonly string[] => this.hello?.capabilities ?? [];
    this.capabilities = {
      get list() {
        return capabilities();
      },
      isSupported: (name) => capabilities().includes(name),
    };
  }

  /** @internal Resolves with the first handshake. */
  start(): Promise<HelloResult> {
    return this.connection.start();
  }

  private get current(): HelloResult {
    if (!this.hello) throw new CadencrError("DISCONNECTED", "The client has not connected yet");
    return this.hello;
  }

  get context(): TabContext {
    return this.current.context;
  }

  get theme(): ThemeSnapshot {
    return this.current.theme;
  }

  get instanceId(): string {
    return this.current.instanceId;
  }

  get plugin(): { id: string; version: string } {
    return this.current.plugin;
  }

  get apiVersion(): number {
    return this.current.apiVersion;
  }

  /** Whether the tab is currently shown. */
  get visible(): boolean {
    return this.isVisible;
  }

  /** The ids of the manifest's `shortcuts` that can fire (not taken by Cadencr). */
  get shortcuts(): readonly string[] {
    return this.current.shortcuts ?? [];
  }

  get connected(): boolean {
    return this.connection.connected;
  }

  onContextChange(listener: (context: TabContext) => void): () => void {
    return this.contextChanges.on(listener);
  }

  onThemeChange(listener: (theme: ThemeSnapshot) => void): () => void {
    return this.themeChanges.on(listener);
  }

  onVisibilityChange(listener: (visible: boolean) => void): () => void {
    return this.visibilityChanges.on(listener);
  }

  /**
   * One of the manifest's `shortcuts` was pressed while the tab had focus;
   * the listener gets its `id`. Cadencr's own shortcuts always win, so a
   * declared one that collides with them never fires (see `shortcuts`).
   */
  onShortcut(listener: (id: string) => void): () => void {
    return this.shortcutPresses.on(listener);
  }

  /** `false` when the host port is lost, `true` once a new one handshakes. */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    return this.connectionChanges.on(listener);
  }

  /** Background failures nobody else handles: stream errors without an
   *  `onError`, failed re-handshakes, malformed host messages. Unobserved
   *  errors are re-thrown asynchronously so they reach `window.onerror`. */
  onError(listener: (error: CadencrError) => void): () => void {
    return this.errors.on(listener);
  }

  /** Raw protocol call — an escape hatch for methods without a helper. */
  call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options: { timeoutMs?: number } = {},
  ): Promise<MethodResult<M>> {
    return this.connection.request(method, params, options.timeoutMs);
  }

  /** Drops every subscription and listener and stops talking to the host.
   *  The port itself stays open: the page may connect again. */
  close(): void {
    releaseDefaultClient(this);
    this.registry.closeAll();
    this.connection.close();
    for (const emitter of [
      this.contextChanges,
      this.themeChanges,
      this.visibilityChanges,
      this.shortcutPresses,
      this.connectionChanges,
      this.errors,
    ]) {
      emitter.clear();
    }
  }

  private reportError(error: CadencrError): void {
    if (this.errors.size > 0) {
      this.errors.emit(error);
      return;
    }
    setTimeout(() => {
      throw error;
    }, 0);
  }

  private onReady(hello: HelloResult, reconnected: boolean): void {
    const previous = this.hello;
    const sameContext =
      !!previous && JSON.stringify(previous.context) === JSON.stringify(hello.context);
    const sameTheme = !!previous && JSON.stringify(previous.theme) === JSON.stringify(hello.theme);
    // Keep the previous identities when nothing changed, so `useTabContext` /
    // `useTheme` consumers don't re-run on a reconnect.
    this.hello = {
      ...hello,
      context: sameContext && previous ? previous.context : hello.context,
      theme: sameTheme && previous ? previous.theme : hello.theme,
    };
    if (this.options.applyTheme && !sameTheme) applyTheme(hello.theme);
    // A page recreated while its tab is hidden must not assume it is shown.
    if (hello.visible !== this.isVisible) {
      this.isVisible = hello.visible;
      this.visibilityChanges.emit(hello.visible);
    }
    if (!reconnected || !previous) return;
    if (!sameContext) this.contextChanges.emit(hello.context);
    if (!sameTheme) this.themeChanges.emit(hello.theme);
    this.registry.resubscribeAll();
  }

  private onEvent(event: string, payload: unknown): void {
    switch (event) {
      case "context.changed": {
        const { context } = payload as EventMap["context.changed"];
        if (this.hello) this.hello = { ...this.hello, context };
        this.contextChanges.emit(context);
        return;
      }
      case "theme.changed": {
        const { theme } = payload as EventMap["theme.changed"];
        if (this.hello) this.hello = { ...this.hello, theme };
        if (this.options.applyTheme) applyTheme(theme);
        this.themeChanges.emit(theme);
        return;
      }
      case "visibility.changed": {
        this.isVisible = (payload as EventMap["visibility.changed"]).visible;
        this.visibilityChanges.emit(this.isVisible);
        return;
      }
      case "shortcut":
        this.shortcutPresses.emit((payload as EventMap["shortcut"]).id);
        return;
      case "stream.event":
      case "stream.resync":
      case "stream.error":
        this.registry.handleEvent(event, payload as EventMap[typeof event]);
        return;
      default:
        // Events from a newer host are ignored: they are additive by design.
        return;
    }
  }
}
