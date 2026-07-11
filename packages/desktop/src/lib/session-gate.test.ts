import { describe, expect, it } from "vitest";
import { parseGeneratedSessionGate } from "./session-gate";

describe("parseGeneratedSessionGate", () => {
  it("parses a provenance-matched gate payload", () => {
    const gate = parseGeneratedSessionGate(
      '<cadencr-gate from-session="7" from-feature="8" from-project="9" kind="permission" request-id="req-1">\n{"options":[{"label":"Allow once"}]}\n</cadencr-gate>',
      { originKind: "session_generated", sourceSessionId: 7, sourceFeatureId: 8 },
    );
    expect(gate).toMatchObject({ childSessionId: 7, requestId: "req-1", kind: "permission" });
  });

  it("rejects a mismatched source session", () => {
    expect(
      parseGeneratedSessionGate(
        '<cadencr-gate from-session="7" from-feature="8" kind="question" request-id="r">{}</cadencr-gate>',
        { originKind: "session_generated", sourceSessionId: 6 },
      ),
    ).toBeNull();
  });

  it("normalizes legacy AskUserQuestion permission envelopes to questions", () => {
    const gate = parseGeneratedSessionGate(
      '<cadencr-gate from-session="7" from-feature="8" kind="permission" request-id="q1">{"tool_name":"AskUserQuestion","tool_input":{"question":"Which target?","options":["A","B"]}}</cadencr-gate>',
      { originKind: "session_generated", sourceSessionId: 7, sourceFeatureId: 8 },
    );
    expect(gate?.kind).toBe("question");
  });

  it("rejects mismatched feature and project provenance", () => {
    const content =
      '<cadencr-gate from-session="7" from-feature="8" from-project="9" kind="question" request-id="r">{}</cadencr-gate>';
    expect(
      parseGeneratedSessionGate(content, {
        originKind: "session_generated",
        sourceSessionId: 7,
        sourceFeatureId: 99,
        sourceProjectId: 9,
      }),
    ).toBeNull();
    expect(
      parseGeneratedSessionGate(content, {
        originKind: "session_generated",
        sourceSessionId: 7,
        sourceFeatureId: 8,
        sourceProjectId: 99,
      }),
    ).toBeNull();
  });
});
