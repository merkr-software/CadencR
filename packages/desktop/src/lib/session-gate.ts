import type { AgentMessageOrigin } from "@/api/generated";
import {
  decodeXmlAttribute,
  matchesGeneratedSessionOrigin,
  optionalPositiveInteger,
  parseSessionEnvelope,
  positiveInteger,
} from "@/lib/session-envelope";

export type SessionGateKind = "permission" | "question" | "plan";

export interface SessionGateEnvelope {
  childSessionId: number;
  childFeatureId: number;
  childFeatureTitle?: string;
  childProjectId?: number;
  kind: SessionGateKind;
  requestId: string;
  payload: unknown;
}

export function parseGeneratedSessionGate(
  content: string,
  origin: AgentMessageOrigin | null | undefined,
): SessionGateEnvelope | null {
  const envelope = parseSessionEnvelope(content, "cadencr-gate");
  if (!envelope) return null;
  const attrs = envelope.attributes;
  const childSessionId = positiveInteger(attrs["from-session"]);
  const childFeatureId = positiveInteger(attrs["from-feature"]);
  const childFeatureTitle = decodeXmlAttribute(attrs["from-feature-title"]);
  const childProjectId = optionalPositiveInteger(attrs["from-project"]);
  const kind = attrs.kind;
  if (
    childSessionId === null ||
    childFeatureId === null ||
    !isKind(kind) ||
    !attrs["request-id"] ||
    !matchesGeneratedSessionOrigin(origin, childSessionId, childFeatureId, childProjectId)
  )
    return null;
  try {
    const payload: unknown = JSON.parse(envelope.body);
    return {
      childSessionId,
      childFeatureId,
      childFeatureTitle,
      childProjectId,
      kind: normalizedKind(kind, payload),
      requestId: decodeXmlAttribute(attrs["request-id"]) ?? attrs["request-id"],
      payload,
    };
  } catch {
    return null;
  }
}

function normalizedKind(kind: SessionGateKind, payload: unknown): SessionGateKind {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "tool_name" in payload &&
    payload.tool_name === "AskUserQuestion"
  ) {
    return "question";
  }
  return kind;
}

function isKind(value: string | undefined): value is SessionGateKind {
  return value === "permission" || value === "question" || value === "plan";
}
