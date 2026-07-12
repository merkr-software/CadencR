import { describe, expect, it } from "vitest";
import {
  nextThinkingEffort,
  parseThinkingEffort,
  supportedThinkingEffortLevels,
  thinkingEffortLabel,
  thinkingEffortModelKey,
  type ThinkingEffortLevel,
} from "./thinking-effort";

describe("thinking-effort helpers", () => {
  const effort = (value: string) => parseThinkingEffort(value) as ThinkingEffortLevel;

  it("returns only supported ordered effort levels", () => {
    const model = {
      supports_effort: true,
      supported_effort_levels: ["ultra", "future-deep", "low"],
    };
    const levels = supportedThinkingEffortLevels(model);

    expect(levels).toEqual(["ultra", "future-deep", "low"]);
    expect(supportedThinkingEffortLevels(model)).toBe(levels);
  });

  it("accepts non-empty effort values supplied by a provider", () => {
    expect(parseThinkingEffort("future-deep")).toBe("future-deep");
    expect(parseThinkingEffort("  ")).toBeUndefined();
  });

  it("generates labels without a fixed effort list", () => {
    expect(thinkingEffortLabel(effort("xhigh"))).toBe("Extra High");
    expect(thinkingEffortLabel(effort("future-deep"))).toBe("Future Deep");
    expect(thinkingEffortLabel(effort("xenon"))).toBe("Xenon");
  });

  it("builds per-model setting keys matching the Rust helper", () => {
    expect(thinkingEffortModelKey("claude_code", "claude-opus-4")).toBe(
      "thinking_effort_model_claude_code_claude-opus-4",
    );
    expect(thinkingEffortModelKey("opencode", "claude-sonnet-4-5")).toBe(
      "thinking_effort_model_opencode_claude-sonnet-4-5",
    );
  });

  it("cycles to the next supported effort", () => {
    const standard = [effort("low"), effort("medium"), effort("high")];
    const extended = [effort("max"), effort("ultra")];
    expect(nextThinkingEffort(standard, "medium")).toBe("high");
    expect(nextThinkingEffort(standard, "high")).toBe("low");
    expect(nextThinkingEffort(extended, "max")).toBe("ultra");
    expect(nextThinkingEffort(extended, "ultra")).toBe("max");
    expect(nextThinkingEffort([], "high")).toBeUndefined();
  });
});
