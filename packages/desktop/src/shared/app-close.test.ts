import { describe, expect, it } from "vitest";
import { parseAppCloseChoice, RESUME_AGENTS } from "./app-close";

describe("parseAppCloseChoice", () => {
  it("defaults to resuming the agents", () => {
    expect(parseAppCloseChoice(undefined)).toEqual(RESUME_AGENTS);
  });

  it("keeps an explicit choice", () => {
    expect(parseAppCloseChoice({ resumeAgents: false })).toEqual({ resumeAgents: false });
  });

  it("rejects anything else", () => {
    expect(() => parseAppCloseChoice({ resumeAgents: "no" })).toThrow("Invalid close choice");
    expect(() => parseAppCloseChoice(null)).toThrow("Invalid close choice");
  });
});
