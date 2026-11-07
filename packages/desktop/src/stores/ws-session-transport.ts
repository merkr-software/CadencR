import type { WsConnection } from "@/lib/ws-connection";
import type { WsEnvelope } from "@/lib/ws-envelope";
import type { SessionCommandSpec } from "./ws-session-commands";
import {
  createPromptDeliveryTracker,
  SESSION_CLOSED_BEFORE_DELIVERY,
} from "./ws-session-prompt-delivery";

/** How long a correlated reply may take before a request gives up on it. */
export const WS_REPLY_TIMEOUT_MS = 10_000;

/** A session command awaiting its correlated reply (see `ws-session-commands`). */
export interface PendingSessionCommand {
  envelope: WsEnvelope;
  spec: SessionCommandSpec;
  /** Still in the outbound queue, droppable after this instant; null once sent. */
  queuedUntil: number | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface FlushHooks {
  onSent: (envelopeId: string) => void;
  onExpired: (command: PendingSessionCommand) => void;
}

interface SessionTransport {
  conn: WsConnection | null;
  pendingWsRequests: Map<string, (payload: unknown) => void>;
  pendingCommands: Map<string, PendingSessionCommand>;
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
        pendingCommands: new Map(),
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

  /** Take a queued envelope back out; true when it was still waiting. */
  unqueue(sessionId: string, envelopeId: string): boolean {
    const queue = this.get(sessionId)?.outboundQueue;
    const index = queue?.findIndex((envelope) => envelope.id === envelopeId) ?? -1;
    if (index === -1) return false;
    queue?.splice(index, 1);
    return true;
  }

  /**
   * Replay the outbound queue. A command whose queue lifetime ran out is never
   * replayed: `onExpired` reports it instead of letting it act late.
   */
  flush(sessionId: string, hooks?: FlushHooks): void {
    const transport = this.get(sessionId);
    if (!transport?.conn) return;
    const now = Date.now();
    transport.outboundQueue = transport.outboundQueue.filter((envelope) => {
      const command = transport.pendingCommands.get(envelope.id);
      if (command?.queuedUntil == null || command.queuedUntil > now) return true;
      hooks?.onExpired(command);
      return false;
    });
    const queue = transport.outboundQueue;
    let sent = 0;
    while (sent < queue.length && transport.conn.sendJson(queue[sent])) sent += 1;
    const flushed = queue.splice(0, sent).map((envelope) => envelope.id);
    transport.delivery.settle(flushed);
    for (const envelopeId of flushed) hooks?.onSent(envelopeId);
  }

  remove(sessionId: string): void {
    const transport = this.get(sessionId);
    if (!transport) return;
    this.rejectPendingRequests(sessionId);
    transport.outboundQueue.splice(0);
    for (const command of transport.pendingCommands.values()) clearTimeout(command.timer);
    transport.pendingCommands.clear();
    transport.delivery.fail(SESSION_CLOSED_BEFORE_DELIVERY);
    // Remove ownership before closing: synchronous or late callbacks are stale.
    this.sessions.delete(sessionId);
    transport.conn?.close();
    transport.conn = null;
  }
}
