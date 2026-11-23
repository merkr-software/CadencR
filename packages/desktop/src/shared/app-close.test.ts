import { describe, expect, it } from "vitest";
import {
  dialogCloseChoice,
  parseAppCloseChoice,
  QUIT_WITHOUT_ASKING,
  RESUME_AGENTS,
} from "./app-close";

describe("parseAppCloseChoice", () => {
  it("defaults to resuming the agents and their background work", () => {
    expect(parseAppCloseChoice(undefined)).toEqual(RESUME_AGENTS);
    expect(RESUME_AGENTS).toEqual({ resumeAgents: true, resumeBackgroundWork: true });
  });

  it("keeps an explicit choice", () => {
    expect(parseAppCloseChoice(QUIT_WITHOUT_ASKING)).toEqual({
      resumeAgents: true,
      resumeBackgroundWork: false,
    });
  });

  it("rejects anything else", () => {
    expect(() => parseAppCloseChoice({ resumeAgents: "no" })).toThrow("Invalid close choice");
    expect(() => parseAppCloseChoice({ resumeAgents: false })).toThrow("Invalid close choice");
    expect(() => parseAppCloseChoice(null)).toThrow("Invalid close choice");
  });
});

describe("dialogCloseChoice", () => {
  it("applies the dialog's answer to background work too", () => {
    expect(dialogCloseChoice(true)).toEqual(RESUME_AGENTS);
    expect(dialogCloseChoice(false)).toEqual({ resumeAgents: false, resumeBackgroundWork: false });
  });
});
