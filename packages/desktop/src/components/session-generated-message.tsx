import type { ReactElement } from "react";
import type { AgentMessageOrigin } from "@/api/generated";
import { SessionGateBlock } from "@/components/SessionGateBlock";
import { SessionReplyBlock } from "@/components/SessionReplyBlock";
import { parseGeneratedSessionGate } from "@/lib/session-gate";
import { parseGeneratedSessionReply, type SessionReplyEnvelope } from "@/lib/session-reply";

export function renderGeneratedSessionMessage(
  content: string,
  origin: AgentMessageOrigin | null | undefined,
  replyOverride: SessionReplyEnvelope | null | undefined,
): ReactElement | null {
  const reply =
    replyOverride === undefined ? parseGeneratedSessionReply(content, origin) : replyOverride;
  if (reply) return <SessionReplyBlock reply={reply} />;
  const gate = parseGeneratedSessionGate(content, origin);
  return gate ? <SessionGateBlock gate={gate} /> : null;
}
