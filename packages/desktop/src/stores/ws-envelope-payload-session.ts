import type { AgentMessageOrigin } from "@/api/generated";
import {
  asRecord,
  optionalArray,
  optionalNumber,
  optionalString,
} from "./ws-envelope-payload-primitives";

interface ParsedPermissionOption {
  decision: "allow_once" | "allow_future" | "deny";
  optionId?: string;
  label: string;
  description: string;
  collectFeedback?: boolean;
}

export function parseMessageBlocksPayload(
  payload: unknown,
): { blocks: unknown[]; seq: number | null } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    blocks: optionalArray(record, "blocks") ?? [],
    seq: optionalNumber(record, "seq") ?? null,
  };
}

export function parsePermissionPayload(payload: unknown): {
  request_id?: string;
  tool_name?: string;
  tool_input: Record<string, unknown>;
  description?: string;
  pattern?: string;
  preview?: string;
  options: ParsedPermissionOption[];
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const toolInputRecord = asRecord(record.tool_input) ?? {};
  const options = (optionalArray(record, "options") ?? [])
    .map((entry): ParsedPermissionOption | null => {
      const item = asRecord(entry);
      if (!item) return null;
      const decision = optionalString(item, "decision");
      const label = optionalString(item, "label");
      const description = optionalString(item, "description");
      const collectFeedback = item.collect_feedback;
      if (!decision || !label || !description) return null;
      if (decision !== "allow_once" && decision !== "allow_future" && decision !== "deny") {
        return null;
      }
      return {
        decision,
        optionId: optionalString(item, "option_id"),
        label,
        description,
        collectFeedback: typeof collectFeedback === "boolean" ? collectFeedback : undefined,
      };
    })
    .filter((entry): entry is ParsedPermissionOption => entry !== null);
  return {
    request_id: optionalString(record, "request_id"),
    tool_name: optionalString(record, "tool_name"),
    tool_input: toolInputRecord,
    description: optionalString(record, "description"),
    pattern: optionalString(record, "pattern"),
    preview: optionalString(record, "preview"),
    options,
  };
}

export function parseErrorPayload(payload: unknown): {
  code?: string;
  message?: string;
  mode?: string;
  retryAfterMs?: number;
  receivedPromptMessageUuids: string[];
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    code: optionalString(record, "code"),
    message: optionalString(record, "message") ?? optionalString(record, "error"),
    // Optional context attached to permission-mode rejections so the FE
    // can skip the rejected mode in the Shift+Tab cycle.
    mode: optionalString(record, "mode"),
    retryAfterMs: optionalNumber(record, "retry_after_ms"),
    receivedPromptMessageUuids: (
      optionalArray(record, "received_prompt_message_uuids") ?? []
    ).filter((value): value is string => typeof value === "string"),
  };
}

export function parseEndedPayload(
  payload: unknown,
): { reason?: string; receivedPromptMessageUuids: string[] } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const receivedPromptMessageUuids = (
    optionalArray(record, "received_prompt_message_uuids") ?? []
  ).filter((value): value is string => typeof value === "string");
  return {
    reason: optionalString(record, "reason"),
    receivedPromptMessageUuids,
  };
}

/**
 * Parse the `session.stream_status` envelope. Backend emits exactly one
 * of `"degraded"` or `"recovered"` for `state`; we narrow defensively
 * (anything else is ignored). Hard failures arrive on `session.error`,
 * not here.
 */
export function parseStreamStatusPayload(
  payload: unknown,
): { state: "degraded" | "recovered"; reason?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const state = optionalString(record, "state");
  if (state !== "degraded" && state !== "recovered") return null;
  return { state, reason: optionalString(record, "reason") };
}

export function parsePromptReceivedPayload(payload: unknown): {
  message_uuid: string;
  delivery_state: "received_agent" | "delivery_failed";
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const messageUuid = optionalString(record, "message_uuid");
  const deliveryState = optionalString(record, "delivery_state");
  if (!messageUuid || (deliveryState !== "received_agent" && deliveryState !== "delivery_failed")) {
    return null;
  }
  return {
    message_uuid: messageUuid,
    delivery_state: deliveryState,
  };
}

/** Parse the canonical persisted `session.user_message` envelope. */
export function parseCanonicalUserMessagePayload(payload: unknown): {
  messageId: number;
  messageUuid: string;
  text: string;
  createdAt: string;
  origin?: AgentMessageOrigin;
  promptDeliveryState?: "pending_agent";
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const messageId = optionalNumber(record, "message_id");
  const messageUuid = optionalString(record, "message_uuid");
  const text = optionalString(record, "text");
  const createdAt = optionalString(record, "created_at");
  if (
    messageId === undefined ||
    !Number.isSafeInteger(messageId) ||
    messageId <= 0 ||
    !messageUuid ||
    typeof text !== "string" ||
    !createdAt
  ) {
    return null;
  }
  const origin = parseMessageOrigin(record.origin);
  const deliveryState = optionalString(record, "prompt_delivery_state");
  const promptDeliveryState = deliveryState === "pending_agent" ? deliveryState : undefined;
  return {
    messageId,
    messageUuid,
    text,
    createdAt,
    ...(origin ? { origin } : {}),
    ...(promptDeliveryState ? { promptDeliveryState } : {}),
  };
}

function parseMessageOrigin(value: unknown): AgentMessageOrigin | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const originKind = optionalString(record, "originKind");
  if (!originKind) return undefined;
  return {
    originKind,
    sourceSessionId: optionalNumber(record, "sourceSessionId"),
    sourceFeatureId: optionalNumber(record, "sourceFeatureId"),
    sourceProjectId: optionalNumber(record, "sourceProjectId"),
    sourceMessageId: optionalNumber(record, "sourceMessageId"),
    note: optionalString(record, "note"),
    createdAt: optionalString(record, "createdAt"),
  };
}

/**
 * Parse the `session.lifecycle` envelope. Carries OS-power-driven
 * transitions (suspend / resume). Anything other than the two known kinds
 * is ignored — we'd rather drop than crash if the backend adds a new kind
 * we don't yet handle in the renderer.
 */
export function parseLifecyclePayload(
  payload: unknown,
): { kind: "suspend_requested" | "resumed" } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const kind = optionalString(record, "kind");
  if (kind !== "suspend_requested" && kind !== "resumed") return null;
  return { kind };
}

export function parseGateClosedPayload(payload: unknown): {
  session_id?: string;
  request_id?: string;
  reason: "sleep" | "escape";
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const reason = optionalString(record, "reason");
  if (reason !== "sleep" && reason !== "escape") return null;
  return {
    session_id: optionalString(record, "session_id"),
    request_id: optionalString(record, "request_id"),
    reason,
  };
}

export function parseUsagePayload(payload: unknown): {
  input_tokens: number;
  output_tokens: number;
  context_window?: number;
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const contextWindow = optionalNumber(record, "context_window");
  return {
    input_tokens: optionalNumber(record, "input_tokens") ?? 0,
    output_tokens: optionalNumber(record, "output_tokens") ?? 0,
    context_window: contextWindow && contextWindow > 0 ? contextWindow : undefined,
  };
}

export function parseFeatureRenamePayload(
  payload: unknown,
): { feature_id?: number; title?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    feature_id: optionalNumber(record, "feature_id"),
    title: optionalString(record, "title"),
  };
}

export function parseFeatureAutoNamingPayload(
  payload: unknown,
): { feature_id?: number; in_progress: boolean } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    feature_id: optionalNumber(record, "feature_id"),
    in_progress: record.in_progress === true,
  };
}

export function parseClearedPayload(payload: unknown): { previous_session_id?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { previous_session_id: optionalString(record, "previous_session_id") };
}
