import { describe, expect, it } from "vitest";
import type { Query } from "@tanstack/react-query";
import { CACHE_VERSION, shouldDehydrateQuery } from "./persistedQueries";

function makeQuery(url: string, status: "success" | "loading" | "error" = "success"): Query {
  return {
    queryKey: [url] as readonly unknown[],
    state: { status },
  } as unknown as Query;
}

describe("persistedQueries", () => {
  it("exports a cache version string", () => {
    expect(CACHE_VERSION).toMatch(/^v\d+$/);
  });

  it("persists safelisted endpoints when successful", () => {
    expect(shouldDehydrateQuery(makeQuery("/api/projects"))).toBe(true);
    expect(shouldDehydrateQuery(makeQuery("/api/features"))).toBe(true);
    expect(shouldDehydrateQuery(makeQuery("/api/workspace/settings"))).toBe(true);
    expect(shouldDehydrateQuery(makeQuery("/api/workspace/model-settings"))).toBe(true);
    expect(shouldDehydrateQuery(makeQuery("/api/workspace/provider-settings"))).toBe(true);
    expect(shouldDehydrateQuery(makeQuery("/api/agent-catalog"))).toBe(true);
  });

  it("persists per-project settings sub-routes", () => {
    expect(shouldDehydrateQuery(makeQuery("/api/projects/42/settings"))).toBe(true);
  });

  it("does NOT persist the live sub-agent list", () => {
    expect(shouldDehydrateQuery(makeQuery("/api/features/1076/subagents"))).toBe(false);
  });

  it("does NOT persist agent-state (multi-MB payload)", () => {
    expect(shouldDehydrateQuery(makeQuery("/api/features/1076/agent-state"))).toBe(false);
    expect(shouldDehydrateQuery(makeQuery("/api/features/1076/agent-state?after=foo"))).toBe(false);
  });

  it("does NOT persist binary bodies, which serialize to {}", () => {
    const query = {
      queryKey: ["/api/features/7/agent-image", { src: "/tmp/qa/shot.png" }],
      state: { status: "success", data: new Blob(["png"], { type: "image/png" }) },
    } as unknown as Query;
    expect(shouldDehydrateQuery(query)).toBe(false);
  });

  it("does NOT persist allocated ports (a restored scan would list dead servers)", () => {
    expect(shouldDehydrateQuery(makeQuery("/api/features/ports"))).toBe(false);
  });

  it("does NOT persist git endpoints (volatile)", () => {
    expect(shouldDehydrateQuery(makeQuery("/api/git/diff"))).toBe(false);
    expect(shouldDehydrateQuery(makeQuery("/api/git/branch"))).toBe(false);
    expect(shouldDehydrateQuery(makeQuery("/api/git/stats"))).toBe(false);
  });

  it("does NOT persist /api/health", () => {
    expect(shouldDehydrateQuery(makeQuery("/api/health"))).toBe(false);
  });

  it("does NOT persist non-success queries", () => {
    expect(shouldDehydrateQuery(makeQuery("/api/projects", "loading"))).toBe(false);
    expect(shouldDehydrateQuery(makeQuery("/api/projects", "error"))).toBe(false);
  });

  it("does NOT persist project sub-routes that aren't settings", () => {
    expect(shouldDehydrateQuery(makeQuery("/api/projects/42/files"))).toBe(false);
    expect(shouldDehydrateQuery(makeQuery("/api/projects/42/colors"))).toBe(false);
  });

  it("does NOT persist queries with non-string heads", () => {
    const q = {
      queryKey: [{ foo: 1 }] as readonly unknown[],
      state: { status: "success" },
    } as unknown as Query;
    expect(shouldDehydrateQuery(q)).toBe(false);
  });
});
