import { CadencrError, toCadencrError } from "./errors.js";
import {
  SUPPORTED_API_VERSIONS,
  type HelloResult,
  type MethodName,
  type MethodParams,
  type MethodResult,
} from "./protocol.js";
import { RpcConnection } from "./rpc.js";
import type { PortSource } from "./transport.js";
import { SDK_VERSION } from "./version.js";

export interface ConnectionEvents {
  /** A handshake succeeded; `reconnected` is false for the first one. */
  onReady(hello: HelloResult, reconnected: boolean): void;
  onEvent(event: string, payload: unknown): void;
  onConnectionChange(connected: boolean): void;
  onError(error: CadencrError): void;
}

export interface ConnectionOptions {
  requestTimeoutMs: number;
  handshakeTimeoutMs: number;
}

function validateHello(value: unknown): HelloResult {
  const hello = value as Partial<HelloResult> | null;
  if (
    typeof hello !== "object" ||
    hello === null ||
    typeof hello.apiVersion !== "number" ||
    typeof hello.instanceId !== "string" ||
    typeof hello.context !== "object" ||
    typeof hello.theme !== "object" ||
    !Array.isArray(hello.capabilities)
  ) {
    throw new CadencrError("HOST_ERROR", "The host answered hello with an unexpected shape", {
      details: value,
    });
  }
  const [min, max] = SUPPORTED_API_VERSIONS;
  if (hello.apiVersion < min || hello.apiVersion > max) {
    throw new CadencrError(
      "PLUGIN_API_UNSUPPORTED",
      `The host chose plugin API v${hello.apiVersion}; this SDK speaks v${min}–v${max}`,
      { details: { apiVersion: hello.apiVersion, supported: SUPPORTED_API_VERSIONS } },
    );
  }
  return hello as HelloResult;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const disconnected = (message: string) => new CadencrError("DISCONNECTED", message);

/**
 * Owns the port lifecycle: handshakes on every port the source delivers,
 * replaces the previous one, and gates requests on the handshake in flight.
 */
export class Connection {
  private current: RpcConnection | null = null;
  private handshake: Promise<HelloResult> | null = null;
  private hasConnected = false;
  private closed = false;
  private unsubscribeSource: () => void = () => {};
  private readonly first = deferred<HelloResult>();

  constructor(
    private readonly source: PortSource,
    private readonly options: ConnectionOptions,
    private readonly events: ConnectionEvents,
  ) {}

  /** Resolves with the first successful handshake. */
  start(): Promise<HelloResult> {
    this.unsubscribeSource = this.source.subscribe((port) => this.attach(port));
    return this.first.promise;
  }

  get connected(): boolean {
    return this.current !== null && this.handshake === null && !this.closed;
  }

  async request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    timeoutMs?: number,
  ): Promise<MethodResult<M>> {
    if (this.closed) throw disconnected("The Cadencr client is closed");
    if (this.handshake) await this.handshake;
    const conn = this.current;
    if (!conn) throw disconnected("Not connected to the Cadencr host");
    return conn.request(method, params, timeoutMs);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSource();
    this.current?.dispose(disconnected("The Cadencr client is closed"));
    this.current = null;
    this.handshake = null;
    this.first.reject(disconnected("The Cadencr client was closed before connecting"));
  }

  private attach(port: MessagePort): void {
    if (this.closed) return;
    this.current?.dispose(disconnected("The Cadencr host replaced the connection"));
    const conn: RpcConnection = new RpcConnection(
      port,
      {
        onEvent: (event, payload) => {
          if (this.current === conn) this.events.onEvent(event, payload);
        },
        onClose: () => this.lose(conn),
        onProtocolError: (error) => this.events.onError(error),
      },
      this.options.requestTimeoutMs,
    );
    this.current = conn;
    const reconnected = this.hasConnected;
    const handshake = conn
      .request(
        "hello",
        { sdkVersion: SDK_VERSION, apiVersions: SUPPORTED_API_VERSIONS },
        this.options.handshakeTimeoutMs,
      )
      .then(validateHello);
    this.handshake = handshake;
    handshake.then(
      (hello) => {
        // A newer port superseded this one while hello was in flight.
        if (this.current !== conn) return;
        this.handshake = null;
        this.hasConnected = true;
        this.first.resolve(hello);
        this.events.onReady(hello, reconnected);
        this.events.onConnectionChange(true);
      },
      (error: unknown) => {
        if (this.current !== conn) return;
        const failure = toCadencrError(error);
        this.handshake = null;
        this.current = null;
        conn.dispose(failure);
        if (this.hasConnected) this.events.onError(failure);
        else this.first.reject(failure);
      },
    );
  }

  private lose(conn: RpcConnection): void {
    if (this.current !== conn) return;
    conn.dispose(disconnected("The Cadencr host closed the connection"));
    this.current = null;
    this.handshake = null;
    if (this.hasConnected) this.events.onConnectionChange(false);
  }
}
