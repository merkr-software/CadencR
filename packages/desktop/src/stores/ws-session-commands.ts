/**
 * One request/acknowledgement path for session commands (stop, clear, model,
 * mode, gate close, …).
 *
 * Every command is tracked by its envelope id. The backend correlates its
 * reply — success or `session.error` — through `ref`, so a failure is
 * presented by the command that failed (a toast naming it) instead of the
 * stream's generic "the turn errored" path. A command with no correlated
 * answer within its window succeeded: `interrupt` only answers on failure,
 * and its success shows in the status book instead (`settleInterrupt`).
 *
 * Replay is bounded. A non-idempotent command (stop, clear, close a gate)
 * never waits for a reconnect — replaying a Stop 30 s later would kill
 * another turn — so it fails at once when the socket is down. A setting may
 * wait in the outbound queue for a short TTL, then expires visibly rather
 * than overwriting a choice made since on another device.
 */
import { toast } from "sonner";
import type { WsEnvelope } from "@/lib/ws-envelope";
import type { StoreAccessors } from "./ws-envelope-types";
import { handleCommandError } from "./ws-envelope-error-handler";
import { parseErrorPayload } from "./ws-envelope-payload";
import { WS_REPLY_TIMEOUT_MS, type PendingSessionCommand } from "./ws-session-transport";
import { updateSession } from "./ws-session-types";
import { SESSION_ACTION } from "./ws-session-action-names";

export interface SessionCommandSpec {
  /** Toast headline when the command fails. */
  failure: string;
  /** Whether the command may be replayed after a short reconnect. */
  replay: boolean;
  /** How long a correlated error may still arrive once it is on the wire. */
  ackWindowMs?: number;
  /** Error codes meaning the command's goal already holds: settled, no toast. */
  satisfiedBy?: ReadonlySet<string>;
}

/** How long a replayable command may wait in the queue for a reconnect. */
export const COMMAND_QUEUE_TTL_MS = 5_000;
/**
 * A stop the agent ignores is escalated by the backend (the process is ended
 * and `AGENT_STOP_ESCALATED` shown) within about 25 s: Claude Code gets 15 s to
 * acknowledge and 10 s to end its turn, ACP agents a 15 s grace. A failure is
 * reported within that, plus margin.
 */
const INTERRUPT_ACK_WINDOW_MS = 40_000;

export const SESSION_COMMANDS = {
  interrupt: {
    failure: "Couldn't stop the agent",
    replay: false,
    ackWindowMs: INTERRUPT_ACK_WINDOW_MS,
    // Nothing was running (the turn ended first): stopped is what the user
    // asked for. A turn still starting answers `AGENT_STARTING` instead.
    satisfiedBy: new Set(["NOTHING_TO_STOP"]),
  },
  // A refused pause leaves the agent working into the sleep: a toast, not a
  // failed turn (the turn goes on).
  suspend: {
    failure: "Agent kept running into sleep",
    replay: false,
    ackWindowMs: INTERRUPT_ACK_WINDOW_MS,
  },
  clear: { failure: "Couldn't clear the conversation", replay: false },
  gateClose: { failure: "Couldn't dismiss the request", replay: false },
  provider: { failure: "Couldn't switch provider", replay: true },
  model: { failure: "Couldn't switch model", replay: true },
  effort: { failure: "Couldn't change thinking effort", replay: true },
  profile: { failure: "Couldn't switch profile", replay: true },
  mode: { failure: "Couldn't change permission mode", replay: true },
  accessMode: { failure: "Couldn't change access mode", replay: true },
} as const satisfies Record<string, SessionCommandSpec>;

const NOT_CONNECTED = "Not connected to the backend. Try again once it reconnects.";

function setPendingActions(ctx: StoreAccessors, sessionId: string): void {
  if (!ctx.get().sessions[sessionId]) return;
  const commands = ctx.transport.get(sessionId)?.pendingCommands;
  const actions = commands ? [...commands.values()].map((c) => c.envelope.action) : [];
  ctx.set(updateSession(ctx.get(), sessionId, { pendingCommandActions: actions }));
}

function settle(ctx: StoreAccessors, sessionId: string, envelopeId: string) {
  const commands = ctx.transport.get(sessionId)?.pendingCommands;
  const command = commands?.get(envelopeId);
  if (!command) return null;
  clearTimeout(command.timer);
  commands?.delete(envelopeId);
  setPendingActions(ctx, sessionId);
  return command;
}

function reportUnsent(failure: string, envelopeId: string): void {
  toast.error(failure, { id: `ws-command:${envelopeId}`, description: NOT_CONNECTED });
}

/** Its window closed: silence means success, unless it never left the queue. */
function expireCommand(ctx: StoreAccessors, sessionId: string, envelopeId: string): void {
  const stillQueued = ctx.transport.unqueue(sessionId, envelopeId);
  const command = settle(ctx, sessionId, envelopeId);
  if (command && stillQueued) reportUnsent(command.spec.failure, envelopeId);
}

function armTimer(ctx: StoreAccessors, sessionId: string, command: PendingSessionCommand): void {
  clearTimeout(command.timer);
  const ms =
    command.queuedUntil == null
      ? (command.spec.ackWindowMs ?? WS_REPLY_TIMEOUT_MS)
      : COMMAND_QUEUE_TTL_MS;
  command.timer = setTimeout(() => expireCommand(ctx, sessionId, command.envelope.id), ms);
}

/**
 * Send a tracked command. Returns false when it was refused locally (no
 * session, or a non-replayable command while disconnected — already toasted).
 */
export function sendSessionCommand(
  ctx: StoreAccessors,
  sessionId: string,
  envelope: WsEnvelope,
  spec: SessionCommandSpec,
): boolean {
  if (!ctx.get().sessions[sessionId]) return false;
  const transport = ctx.transport.ensure(sessionId);
  const sent = transport.conn?.sendJson(envelope) ?? false;
  if (!sent && !spec.replay) {
    reportUnsent(spec.failure, envelope.id);
    return false;
  }
  if (!sent) transport.outboundQueue.push(envelope);
  const command: PendingSessionCommand = {
    envelope,
    spec,
    queuedUntil: sent ? null : Date.now() + COMMAND_QUEUE_TTL_MS,
    timer: undefined,
  };
  transport.pendingCommands.set(envelope.id, command);
  armTimer(ctx, sessionId, command);
  setPendingActions(ctx, sessionId);
  return true;
}

/** Flush hooks: a queued command that left now waits on its ack window. */
export function queuedCommandHooks(ctx: StoreAccessors, sessionId: string) {
  return {
    onSent(envelopeId: string): void {
      const command = ctx.transport.get(sessionId)?.pendingCommands.get(envelopeId);
      if (!command || command.queuedUntil == null) return;
      command.queuedUntil = null;
      armTimer(ctx, sessionId, command);
    },
    /** It outlived its TTL: dropped, never replayed late. */
    onExpired(command: PendingSessionCommand): void {
      if (settle(ctx, sessionId, command.envelope.id)) {
        reportUnsent(command.spec.failure, command.envelope.id);
      }
    },
  };
}

/**
 * The socket dropped. Requests fail now; commands already on the wire have an
 * unknown outcome and must not be replayed, so say so. Queued replayable
 * commands keep their TTL.
 */
export function abandonInFlight(ctx: StoreAccessors, sessionId: string): void {
  ctx.transport.rejectPendingRequests(sessionId);
  const transport = ctx.transport.get(sessionId);
  if (!transport?.pendingCommands.size) return;
  for (const command of [...transport.pendingCommands.values()]) {
    if (command.queuedUntil != null) continue;
    settle(ctx, sessionId, command.envelope.id);
    toast.warning(command.spec.failure, {
      id: `ws-command:${command.envelope.id}`,
      description: "The connection dropped before the backend answered. Check that it took effect.",
    });
  }
}

/**
 * The status book reports the session no longer working: a pending stop
 * succeeded (the backend sends no reply for that), so it is settled now.
 */
export function settleInterrupt(ctx: StoreAccessors, sessionId: string): void {
  const commands = ctx.transport.get(sessionId)?.pendingCommands;
  if (!commands) return;
  for (const [envelopeId, command] of commands) {
    if (command.spec === SESSION_COMMANDS.interrupt) settle(ctx, sessionId, envelopeId);
  }
}

/**
 * Settle the command a reply answers. Returns true when the reply was a
 * command failure, fully handled here; a success reply still flows through
 * the normal handlers (they apply the confirmed value).
 */
export function settleCommandReply(
  ctx: StoreAccessors,
  sessionId: string,
  envelope: { domain: string; action: string; ref?: string; payload: unknown },
): boolean {
  if (!envelope.ref) return false;
  const command = settle(ctx, sessionId, envelope.ref);
  if (!command) return false;
  if (envelope.domain !== "session" || envelope.action !== SESSION_ACTION.error) return false;
  const code = parseErrorPayload(envelope.payload)?.code;
  if (code && command.spec.satisfiedBy?.has(code)) return true;
  handleCommandError(ctx, sessionId, command.spec.failure, envelope.payload);
  return true;
}
