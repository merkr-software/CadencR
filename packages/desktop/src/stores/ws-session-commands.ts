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
 * another turn — so it fails at once when the socket is down. A setting
 * (model, effort, mode, …) is the user's latest intent: while the socket is
 * down only the newest of each kind waits in the outbound queue, shown as
 * waiting (`queuedCommandActions`), and leaves with the reconnect. The
 * confirmed value still changes only on the backend's answer. If automatic
 * reconnects give up, the waiting settings expire visibly
 * (`expireQueuedCommands`).
 */
import { toast } from "sonner";
import { isReconnectPaused } from "@/lib/ws-reconnect";
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
    // asked for. A turn still starting is stopped once it runs; only a launch
    // that follows it answers `AGENT_STARTING`.
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
  fastMode: { failure: "Couldn't change fast mode", replay: true },
  // Providers whose model and effort are runtime overrides (Codex).
  runtimeModel: { failure: "Couldn't switch model", replay: true },
  runtimeEffort: { failure: "Couldn't change thinking effort", replay: true },
} as const satisfies Record<string, SessionCommandSpec>;

/** The command kinds (`commandKind`) that change fast mode, one per provider path. */
export const FAST_MODE_COMMAND_KINDS: readonly string[] = [
  "fast_mode.set",
  "runtime_overrides.set:fast_mode",
];

const NOT_CONNECTED = "Not connected to the backend. Try again once it reconnects.";

/** Keeps the previous array when nothing changed, so selectors of it do not re-render. */
function sameOr(previous: readonly string[], next: string[]): readonly string[] {
  return previous.length === next.length && previous.every((action, i) => action === next[i])
    ? previous
    : next;
}

function setPendingActions(ctx: StoreAccessors, sessionId: string): void {
  const session = ctx.get().sessions[sessionId];
  if (!session) return;
  const commands = [...(ctx.transport.get(sessionId)?.pendingCommands.values() ?? [])];
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      pendingCommandActions: sameOr(
        session.pendingCommandActions,
        commands.map((c) => commandKind(c.envelope)),
      ),
      queuedCommandActions: sameOr(
        session.queuedCommandActions,
        commands.filter((c) => c.queued).map((c) => commandKind(c.envelope)),
      ),
    }),
  );
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

/** On the wire: once its window closes, silence means success. */
function armAckTimer(ctx: StoreAccessors, sessionId: string, command: PendingSessionCommand): void {
  clearTimeout(command.timer);
  command.timer = setTimeout(
    () => settle(ctx, sessionId, command.envelope.id),
    command.spec.ackWindowMs ?? WS_REPLY_TIMEOUT_MS,
  );
}

/**
 * What a waiting setting is: its action, or for a runtime override patch the
 * fields it sets (a model change must not replace a waiting effort change).
 */
export function commandKind(envelope: WsEnvelope): string {
  if (envelope.action !== "runtime_overrides.set") return envelope.action;
  const payload = envelope.payload;
  const patch =
    payload && typeof payload === "object" && "runtime_overrides" in payload
      ? payload.runtime_overrides
      : null;
  const fields = patch && typeof patch === "object" ? Object.keys(patch).sort() : [];
  return `${envelope.action}:${fields.join(",")}`;
}

/** A newer setting of the same kind replaces the one still waiting: only the latest is sent. */
function supersedeQueued(ctx: StoreAccessors, sessionId: string, kind: string): void {
  const commands = ctx.transport.get(sessionId)?.pendingCommands;
  for (const command of [...(commands?.values() ?? [])]) {
    if (!command.queued || commandKind(command.envelope) !== kind) continue;
    ctx.transport.unqueue(sessionId, command.envelope.id);
    settle(ctx, sessionId, command.envelope.id);
  }
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
  // A setting may wait for a reconnect that is coming; while reconnects are
  // paused for a manual retry, none is, so it fails at once like a Stop.
  const paused = transport.reconnectKey !== null && isReconnectPaused(transport.reconnectKey);
  if (!sent && (!spec.replay || paused)) {
    reportUnsent(spec.failure, envelope.id);
    return false;
  }
  if (!sent) {
    supersedeQueued(ctx, sessionId, commandKind(envelope));
    transport.outboundQueue.push(envelope);
  }
  const command: PendingSessionCommand = { envelope, spec, queued: !sent, timer: undefined };
  transport.pendingCommands.set(envelope.id, command);
  if (sent) armAckTimer(ctx, sessionId, command);
  setPendingActions(ctx, sessionId);
  return true;
}

/** Flush hooks: a queued command that left now waits on its ack window. */
export function queuedCommandHooks(ctx: StoreAccessors, sessionId: string) {
  return {
    onSent(envelopeId: string): void {
      const command = ctx.transport.get(sessionId)?.pendingCommands.get(envelopeId);
      if (!command?.queued) return;
      command.queued = false;
      armAckTimer(ctx, sessionId, command);
      setPendingActions(ctx, sessionId);
    },
  };
}

/**
 * Automatic reconnects gave up: the settings still waiting are dropped and
 * reported, never sent by a manual retry minutes later. New ones are refused
 * while the reconnect registry keeps the socket paused (until "Retry now").
 */
export function expireQueuedCommands(ctx: StoreAccessors, sessionId: string): void {
  const transport = ctx.transport.get(sessionId);
  if (!transport) return;
  for (const command of [...transport.pendingCommands.values()]) {
    if (!command.queued) continue;
    ctx.transport.unqueue(sessionId, command.envelope.id);
    settle(ctx, sessionId, command.envelope.id);
    reportUnsent(command.spec.failure, command.envelope.id);
  }
}

/**
 * The socket dropped. Requests fail now; commands already on the wire have an
 * unknown outcome and must not be replayed, so say so. Queued settings keep
 * waiting for the reconnect.
 */
export function abandonInFlight(ctx: StoreAccessors, sessionId: string): void {
  ctx.transport.rejectPendingRequests(sessionId);
  const transport = ctx.transport.get(sessionId);
  if (!transport?.pendingCommands.size) return;
  for (const command of [...transport.pendingCommands.values()]) {
    if (command.queued) continue;
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
