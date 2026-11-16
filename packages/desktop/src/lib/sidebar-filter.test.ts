import { describe, expect, it } from "vitest";
import type { Feature, FeatureWorktreeInfo } from "@/api/generated";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import {
  featureMatchesSidebarFilter,
  matchesSidebarFilter,
  sidebarFilterTerms,
} from "./sidebar-filter";

function matches(query: string, texts: (string | null | undefined)[]): boolean {
  return matchesSidebarFilter(sidebarFilterTerms(query), texts);
}

describe("matchesSidebarFilter", () => {
  it("needs every term somewhere, ignoring case and order", () => {
    expect(matches("login FIX", ["Fix the login redirect"])).toBe(true);
    expect(matches("fix bug", ["Fix the login", "bugfix"])).toBe(true);
    expect(matches("fix crash", ["Fix the login"])).toBe(false);
  });

  it("matches everything on a blank query and skips missing texts", () => {
    expect(matches("  ", [null])).toBe(true);
    expect(matches("x", [null, undefined])).toBe(false);
  });
});

describe("featureMatchesSidebarFilter", () => {
  const feature = { id: 4, title: "Old title", label: "infra" } as Feature;
  const worktree = { worktree_branch: "fix/ci" } as FeatureWorktreeInfo;
  const liveMeta = {
    [wsSessionIdFromFeature(4)]: { featureTitle: "New title", isAutoNaming: false },
  };

  it("finds a conversation by live title, title, label and branch", () => {
    for (const query of ["new", "old", "infra", "fix/ci"]) {
      expect(featureMatchesSidebarFilter([query], feature, liveMeta, worktree)).toBe(true);
    }
    expect(featureMatchesSidebarFilter(["ci"], feature, {}, undefined)).toBe(false);
  });
});
