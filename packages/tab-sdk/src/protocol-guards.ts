import {
  EVENT_NAMES,
  METHOD_NAMES,
  PROTOCOL_VERSION,
  type EventName,
  type GuestToHost,
  type HostToGuest,
  type MethodName,
  type WireError,
} from "./protocol.js";
import { isEditorAppearance } from "./surface-protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isGuestToHost(value: unknown): value is GuestToHost {
  return (
    isRecord(value) &&
    value.v === PROTOCOL_VERSION &&
    value.kind === "request" &&
    typeof value.id === "string" &&
    typeof value.method === "string"
  );
}

function isWireError(value: unknown): value is WireError {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

const hasSubscription = (payload: Record<string, unknown>): boolean =>
  typeof payload.subscriptionId === "string";

/** The payload shape each event is checked against before a handler sees it. */
const EVENT_PAYLOADS: { [E in EventName]: (payload: Record<string, unknown>) => boolean } = {
  "context.changed": ({ context }) =>
    isRecord(context) && isRecord(context.project) && isRecord(context.feature),
  "theme.changed": ({ theme }) => isRecord(theme),
  "visibility.changed": ({ visible }) => typeof visible === "boolean",
  "focus.changed": ({ focused }) => typeof focused === "boolean",
  "editor.appearance.changed": ({ appearance }) => isEditorAppearance(appearance),
  "stream.event": (payload) =>
    hasSubscription(payload) &&
    typeof payload.seq === "number" &&
    isRecord(payload.data) &&
    typeof payload.data.domain === "string" &&
    typeof payload.data.action === "string",
  "stream.resync": hasSubscription,
  "stream.error": (payload) => hasSubscription(payload) && isWireError(payload.error),
  "backend.event": (payload) =>
    hasSubscription(payload) &&
    typeof payload.topic === "string" &&
    typeof payload.runId === "string" &&
    Number.isSafeInteger(payload.seq) &&
    Number(payload.seq) > 0 &&
    Number.isSafeInteger(payload.processSeq) &&
    Number(payload.processSeq) > 0 &&
    "payload" in payload,
  "backend.resync": hasSubscription,
  "backend.error": (payload) => hasSubscription(payload) && isWireError(payload.error),
  shortcut: ({ id }) => typeof id === "string",
};

function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}

/**
 * A message from the host, checked at the `MessagePort` boundary: an event
 * (a known one with the payload its handlers expect; an unknown one, from a
 * newer host, is let through for the client to ignore — events are
 * additive), or a response carrying either a result or a well-formed error.
 * Results are method-specific and checked by the method that asked for them.
 */
export function isHostToGuest(value: unknown): value is HostToGuest {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION) return false;
  if (value.kind === "event") {
    if (typeof value.event !== "string" || !isRecord(value.payload)) return false;
    return !isEventName(value.event) || EVENT_PAYLOADS[value.event](value.payload);
  }
  if (value.kind !== "response" || typeof value.id !== "string") return false;
  return "error" in value ? isWireError(value.error) : "result" in value;
}

export function isMethodName(value: string): value is MethodName {
  return (METHOD_NAMES as readonly string[]).includes(value);
}
