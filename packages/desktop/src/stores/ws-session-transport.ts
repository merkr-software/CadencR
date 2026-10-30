import type { WsConnection } from "@/lib/ws-connection";
import type { WsEnvelope } from "@/lib/ws-envelope";
import {
  createPromptDeliveryTracker,
  SESSION_CLOSED_BEFORE_DELIVERY,
} from "./ws-session-prompt-delivery";

interface SessionTransport {
  conn: WsConnection | null;
  pendingWsRequests: Map<string, (payload: unknown) => void>;
  outboundQueue: WsEnvelope[];
  delivery: ReturnType<typeof createPromptDeliveryTracker>;
}

/** Mutable transport resources belong to one store, outside observable state. */
export class SessionTransportRegistry {
  private readonly sessions = new Map<string, SessionTransport>();

  get(sessionId: string): SessionTransport | undefined {
    return this.sessions.get(sessionId);
  }

  ensure(sessionId: string): SessionTransport {
    let transport = this.sessions.get(sessionId);
    if (!transport) {
      transport = {
        conn: null,
        pendingWsRequests: new Map(),
        outboundQueue: [],
        delivery: createPromptDeliveryTracker(),
      };
      this.sessions.set(sessionId, transport);
    }
    return transport;
  }

  /** Failed requests must never execute later as stale queued side effects. */
  rejectPendingRequests(sessionId: string): void {
    const transport = this.get(sessionId);
    if (!transport?.pendingWsRequests.size) return;
    const requestIds = new Set(transport.pendingWsRequests.keys());
    const callbacks = [...transport.pendingWsRequests.values()];
    transport.pendingWsRequests.clear();
    for (let i = transport.outboundQueue.length - 1; i >= 0; i -= 1) {
      if (requestIds.has(transport.outboundQueue[i].id)) transport.outboundQueue.splice(i, 1);
    }
    for (const callback of callbacks) callback(null);
  }

  /** Returns false when the envelope was parked until the next open. */
  send(sessionId: string, envelope: WsEnvelope): boolean {
    const transport = this.ensure(sessionId);
    if (transport.conn?.sendJson(envelope)) return true;
    transport.outboundQueue.push(envelope);
    return false;
  }

  flush(sessionId: string): void {
    const transport = this.get(sessionId);
    if (!transport?.conn) return;
    const queue = transport.outboundQueue;
    let sent = 0;
    while (sent < queue.length && transport.conn.sendJson(queue[sent])) sent += 1;
    const flushed = queue.splice(0, sent);
    transport.delivery.settle(flushed.map((envelope) => envelope.id));
  }

  remove(sessionId: string): void {
    const transport = this.get(sessionId);
    if (!transport) return;
    this.rejectPendingRequests(sessionId);
    transport.outboundQueue.splice(0);
    transport.delivery.fail(SESSION_CLOSED_BEFORE_DELIVERY);
    // Remove ownership before closing: synchronous or late callbacks are stale.
    this.sessions.delete(sessionId);
    transport.conn?.close();
    transport.conn = null;
  }
}
