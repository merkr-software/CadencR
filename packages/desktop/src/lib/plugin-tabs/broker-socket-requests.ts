import type { WsConnection } from "@/lib/ws-connection";
import { createEnvelope, type WsEnvelope } from "@/lib/ws-envelope";
import { BrokerError, toBrokerError } from "./broker-errors";
import { asRecord } from "./broker-stream-messages";

interface Pending {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: BrokerError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Bounded, one-attempt request correlation. Nothing here queues a replay. */
export class SocketRequests {
  private readonly pending = new Map<string, Pending>();

  send(
    socket: WsConnection,
    action: string,
    payload: Record<string, unknown>,
    timeoutMs = 35_000,
  ): Promise<Record<string, unknown>> {
    if (this.pending.size >= 64)
      return Promise.reject(
        new BrokerError("PLUGIN_BACKEND_BUSY", "Too many pending plugin calls"),
      );
    const envelope = createEnvelope("plugin", action, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.id);
        reject(new BrokerError("TIMEOUT", `The plugin socket did not answer ${action}`));
      }, timeoutMs);
      this.pending.set(envelope.id, { resolve, reject, timer });
      try {
        if (!socket.sendJson(envelope))
          throw new BrokerError("DISCONNECTED", "The plugin socket was closed");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(envelope.id);
        reject(toBrokerError(error));
      }
    });
  }

  handle(message: WsEnvelope): boolean {
    const reply = message.ref === undefined ? undefined : this.pending.get(message.ref);
    if (!reply || message.ref === undefined) return false;
    this.pending.delete(message.ref);
    clearTimeout(reply.timer);
    const payload = asRecord(message.payload);
    if (message.action === "subscribed" || message.action === "backend.response")
      reply.resolve(payload);
    else
      reply.reject(
        new BrokerError(
          typeof payload.code === "string" ? payload.code : "HOST_ERROR",
          typeof payload.message === "string" ? payload.message : "Plugin request refused",
        ),
      );
    return true;
  }

  rejectAll(message: string): void {
    for (const reply of this.pending.values()) {
      clearTimeout(reply.timer);
      reply.reject(new BrokerError("DISCONNECTED", message));
    }
    this.pending.clear();
  }
}
