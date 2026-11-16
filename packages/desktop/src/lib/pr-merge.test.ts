import { describe, expect, it } from "vitest";
import type { PrApprovals } from "@/api/generated";
import { approvalsSummary, approvalsTone } from "./pr-merge";

function approvals(overrides: Partial<PrApprovals>): PrApprovals {
  return { reviewers: [], approved_count: 0, required: null, satisfied: null, ...overrides };
}

describe("approvals wording", () => {
  it("counts against the rule when there is one", () => {
    expect(approvalsSummary(approvals({ approved_count: 1, required: 2 }))).toBe(
      "1 of 2 approvals",
    );
    expect(approvalsSummary(approvals({ approved_count: 2 }))).toBe("2 approvals");
    expect(approvalsSummary(approvals({}))).toBe("No approvals yet");
  });

  it("lets requested changes outrank a met requirement", () => {
    const user = { username: "rev" };
    expect(
      approvalsTone(
        approvals({
          satisfied: true,
          reviewers: [{ user, decision: "changes_requested" }],
        }),
      ),
    ).toBe("blocked");
    expect(approvalsTone(approvals({ satisfied: true }))).toBe("ready");
    expect(approvalsTone(approvals({ satisfied: false }))).toBe("blocked");
  });
});
