import { CadencrError } from "./errors.js";
import {
  PROTOCOL_VERSION,
  isHostToGuest,
  type GuestToHost,
  type MethodName,
  type MethodParams,
  type MethodResult,
} from "./protocol.js";

export interface RpcHandlers {
  onEvent(event: string, payload: unknown): void;
  /** The port closed (the host went away). */
  onClose(): void;
  /** A message that is not part of the protocol arrived. */
  onProtocolError(error: CadencrError): void;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: CadencrError): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

// Ids stay unique across every connection in the page, so two clients sharing
// one port (StrictMode re-mount) never consume each other's responses.
let connectionSeq = 0;

/** Request/response correlation and event dispatch over one `MessagePort`.
 *  Never closes the port: the page may hand it to another client. */
export class RpcConnection {
  private readonly pending = new Map<string, Pending>();
  private readonly prefix = `g${++connectionSeq}`;
  private counter = 0;
  private disposed = false;

  constructor(
    private readonly port: MessagePort,
    private readonly handlers: RpcHandlers,
    private readonly defaultTimeoutMs: number,
  ) {
    port.addEventListener("message", this.onMessage);
    port.addEventListener("messageerror", this.onMessageError);
    port.addEventListener("close", this.onClose);
    port.start();
  }

  request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    timeoutMs: number = this.defaultTimeoutMs,
  ): Promise<MethodResult<M>> {
    if (this.disposed) {
      return Promise.reject(new CadencrError("DISCONNECTED", "Not connected to the Cadencr host"));
    }
    const id = `${this.prefix}-${++this.counter}`;
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new CadencrError("TIMEOUT", `${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      const message: GuestToHost = { v: PROTOCOL_VERSION, kind: "request", id, method, params };
      try {
        this.port.postMessage(message);
      } catch (error) {
        this.settle(id)?.reject(
          new CadencrError("BAD_REQUEST", `${method} params cannot be sent: ${String(error)}`, {
            cause: error,
          }),
        );
      }
    });
  }

  /** Rejects every pending request with `reason` and stops listening. */
  dispose(reason: CadencrError): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port.removeEventListener("message", this.onMessage);
    this.port.removeEventListener("messageerror", this.onMessageError);
    this.port.removeEventListener("close", this.onClose);
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(reason);
  }

  private settle(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    return pending;
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const message: unknown = event.data;
    if (!isHostToGuest(message)) {
      this.handlers.onProtocolError(
        new CadencrError("HOST_ERROR", "Received a message outside the Cadencr tab protocol", {
          details: message,
        }),
      );
      return;
    }
    if (message.kind === "event") {
      this.handlers.onEvent(message.event, message.payload);
      return;
    }
    // A response whose request already timed out (or belongs to another
    // client on the same port) has no pending entry: nobody is waiting for it.
    const pending = this.settle(message.id);
    if (!pending) return;
    if ("error" in message) pending.reject(CadencrError.fromWire(message.error));
    else pending.resolve(message.result);
  };

  private readonly onMessageError = (): void => {
    this.handlers.onProtocolError(
      new CadencrError("HOST_ERROR", "A message from the host could not be deserialized"),
    );
  };

  private readonly onClose = (): void => {
    this.handlers.onClose();
  };
}
