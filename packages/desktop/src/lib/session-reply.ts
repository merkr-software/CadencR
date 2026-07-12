import type { AgentMessageOrigin } from "@/api/generated";
import {
  decodeXmlAttribute,
  matchesGeneratedSessionOrigin,
  optionalPositiveInteger,
  parseSessionEnvelope,
  positiveInteger,
} from "@/lib/session-envelope";

export type SessionReplyStatus = "completed" | "failed";
export type SessionReplyLink = "spawned" | "messaged";

export interface SessionReplyEnvelope {
  responderSessionId: number;
  responderFeatureId: number;
  responderFeatureTitle?: string;
  responderProjectId?: number;
  requestMessageId?: number;
  status: SessionReplyStatus;
  link: SessionReplyLink;
  body: string;
}

export function parseSessionReplyEnvelope(content: string): SessionReplyEnvelope | null {
  const envelope = parseSessionEnvelope(content, "cadencr-reply");
  if (!envelope) return null;
  const { attributes } = envelope;
  const responderSessionId = positiveInteger(attributes["from-session"]);
  const responderFeatureId = positiveInteger(attributes["from-feature"]);
  const requestMessageId = optionalPositiveInteger(attributes["request-message-id"]);
  const responderFeatureTitle = decodeXmlAttribute(attributes["from-feature-title"]);
  const responderProjectId = optionalPositiveInteger(attributes["from-project"]);
  const status = attributes.status;
  const link = attributes.link;
  if (
    responderSessionId === null ||
    responderFeatureId === null ||
    (status !== "completed" && status !== "failed") ||
    (link !== "spawned" && link !== "messaged")
  ) {
    return null;
  }
  return {
    responderSessionId,
    responderFeatureId,
    responderFeatureTitle,
    responderProjectId,
    requestMessageId,
    status,
    link,
    body: envelope.body.trim(),
  };
}

export function parseGeneratedSessionReply(
  content: string,
  origin: AgentMessageOrigin | null | undefined,
): SessionReplyEnvelope | null {
  const reply = parseSessionReplyEnvelope(content);
  if (
    !reply ||
    !matchesGeneratedSessionOrigin(
      origin,
      reply.responderSessionId,
      reply.responderFeatureId,
      reply.responderProjectId,
    )
  )
    return null;
  return reply;
}
