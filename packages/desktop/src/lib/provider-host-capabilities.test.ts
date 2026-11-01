import { describe, expect, it } from "vitest";
import { isCompactActionPrompt, validateHostCapabilityFields } from "./provider-host-capabilities";

describe("validateHostCapabilityFields", () => {
  it("normalizes absent and null fields", () => {
    expect(
      validateHostCapabilityFields({
        id: "acme",
        resume_command: null,
        prompt_capabilities: null,
      }),
    ).toEqual({
      id: "acme",
      compact_action: false,
      resume_command: undefined,
      prompt_capabilities: undefined,
    });
  });

  it("keeps well-formed declarations", () => {
    const entry = {
      id: "acme",
      label: "Acme",
      compact_action: true,
      resume_command: { program: "acme", args: ["--resume", "{session_id}"] },
      prompt_capabilities: {
        image: true,
        audio: false,
        embedded_context: true,
      },
    };
    expect(validateHostCapabilityFields(entry)).toEqual(entry);
  });

  it("rejects a malformed declaration instead of using it", () => {
    expect(() =>
      validateHostCapabilityFields({
        id: "acme",
        resume_command: { program: "", args: "x" },
      }),
    ).toThrow(/acme/);
  });
});

describe("isCompactActionPrompt", () => {
  it("routes /compact to the session action only when the catalog declares it", () => {
    expect(isCompactActionPrompt(" /compact ", true)).toBe(true);
    expect(isCompactActionPrompt("/compact", false)).toBe(false);
    expect(isCompactActionPrompt("/compact now", true)).toBe(false);
  });
});
