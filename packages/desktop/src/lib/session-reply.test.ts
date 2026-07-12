import { describe, expect, it } from "vitest";
import { parseGeneratedSessionReply, parseSessionReplyEnvelope } from "./session-reply";

describe("parseSessionReplyEnvelope", () => {
  it("extracts a completed spawned-session reply", () => {
    expect(
      parseSessionReplyEnvelope(
        '<cadencr-reply from-session="3291" from-feature="1780" from-feature-title="QA &amp; routing" from-project="6" status="completed" link="spawned" request-message-id="1959337">\nREPLY_ROUTING_SUCCESS\n</cadencr-reply>',
      ),
    ).toEqual({
      responderSessionId: 3291,
      responderFeatureId: 1780,
      responderFeatureTitle: "QA & routing",
      responderProjectId: 6,
      requestMessageId: 1959337,
      status: "completed",
      link: "spawned",
      body: "REPLY_ROUTING_SUCCESS",
    });
  });

  it("rejects malformed or incomplete envelopes", () => {
    expect(parseSessionReplyEnvelope("ordinary user message")).toBeNull();
    expect(
      parseSessionReplyEnvelope(
        '<cadencr-reply from-session="1" status="completed">missing fields</cadencr-reply>',
      ),
    ).toBeNull();
  });

  it("rejects envelopes whose responder conflicts with message provenance", () => {
    expect(
      parseGeneratedSessionReply(
        '<cadencr-reply from-session="12" from-feature="34" status="completed" link="messaged">ok</cadencr-reply>',
        { originKind: "session_generated", sourceSessionId: 99 },
      ),
    ).toBeNull();
  });
});
