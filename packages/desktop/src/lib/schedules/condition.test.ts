import { describe, expect, it } from "vitest";

import {
  conditionDraftError,
  conditionDraftToInput,
  DEFAULT_CONDITION_TIMEOUT_SECONDS,
  describeLastCheck,
  toConditionDraft,
} from "./condition";

describe("condition drafts", () => {
  it("round-trips a stored condition and leaves the default timeout unstored", () => {
    const draft = toConditionDraft({ command: "pnpm test", timeout_seconds: null });
    expect(draft).toEqual({
      enabled: true,
      command: "pnpm test",
      timeoutSeconds: DEFAULT_CONDITION_TIMEOUT_SECONDS,
    });
    expect(conditionDraftToInput({ ...draft, command: "  pnpm test  " })).toEqual({
      command: "pnpm test",
      timeout_seconds: null,
    });
    expect(conditionDraftToInput({ ...draft, timeoutSeconds: 45 })?.timeout_seconds).toBe(45);
  });

  it("sends null when the condition is off, whatever was typed", () => {
    const draft = { ...toConditionDraft(null), command: "make check" };
    expect(draft.enabled).toBe(false);
    expect(conditionDraftToInput(draft)).toBeNull();
    expect(conditionDraftError(draft)).toBeNull();
  });

  it("refuses an empty command and an out-of-range timeout", () => {
    const on = { enabled: true, command: "pnpm test", timeoutSeconds: 60 };
    expect(conditionDraftError({ ...on, command: "  " })).toMatch(/command/);
    expect(conditionDraftError({ ...on, timeoutSeconds: 0 })).toMatch(/timeout/);
    expect(conditionDraftError({ ...on, timeoutSeconds: 601 })).toMatch(/timeout/);
    expect(conditionDraftError({ ...on, timeoutSeconds: 1.5 })).toMatch(/timeout/);
    expect(conditionDraftError(on)).toBeNull();
  });
});

describe("describeLastCheck", () => {
  const at = new Date().toISOString();

  it("names what each evaluation did", () => {
    expect(describeLastCheck({ at, status: "passed", exit_code: 0 })).toMatch(
      /^Check passed .* nothing sent$/,
    );
    expect(describeLastCheck({ at, status: "triggered", exit_code: 2 })).toMatch(
      /^Command failed \(exit 2\) /,
    );
    expect(describeLastCheck({ at, status: "triggered", exit_code: null })).toMatch(/killed/);
    // Recorded before delivery, so it can't vouch for the prompt arriving.
    expect(describeLastCheck({ at, status: "triggered", exit_code: 1 })).not.toMatch(/sent/);
    expect(describeLastCheck({ at, status: "busy" })).toMatch(/agent was busy/);
    expect(describeLastCheck({ at, status: "error" })).toMatch(/could not run/);
  });
});
