import { describe, expect, it } from "vitest";
import {
  parseSideQuestion,
  SIDE_QUESTION_SKILL,
  withSideQuestionSkill,
} from "./side-question-skill";

describe("parseSideQuestion", () => {
  it("reads the question after either skill trigger", () => {
    expect(parseSideQuestion("/cadencr:side why this approach?")).toBe("why this approach?");
    expect(parseSideQuestion("  $cadencr:side what about\ntests?")).toBe("what about\ntests?");
  });

  it("returns an empty question for the bare command", () => {
    expect(parseSideQuestion("/cadencr:side")).toBe("");
    expect(parseSideQuestion("/cadencr:side   ")).toBe("");
  });

  it("leaves every other prompt alone", () => {
    for (const text of [
      "ask cadencr:side later",
      "/cadencr:sidekick hi",
      "/cadencr:status",
      "/side question",
      "",
    ]) {
      expect(parseSideQuestion(text)).toBeNull();
    }
  });
});

describe("withSideQuestionSkill", () => {
  const review = { name: "cadencr:review", description: "Review", kind: "cadencr" as const };

  it("adds the skill once there is a session", () => {
    expect(withSideQuestionSkill([review], 3)).toEqual([review, SIDE_QUESTION_SKILL]);
    expect(withSideQuestionSkill([review, SIDE_QUESTION_SKILL], 3)).toHaveLength(2);
  });

  it("offers nothing to ask about without a session", () => {
    expect(withSideQuestionSkill([review], undefined)).toEqual([review]);
    expect(withSideQuestionSkill(undefined, 3)).toBeUndefined();
  });
});
