import { describe, expect, it } from "vitest";
import { planCliOpen, type CliOpenSources, type CliRecordedWorktree } from "./plan-cli-open";
import { chooseCheckoutFeature, resolveCliPathOwner } from "./resolve-cli-path";

describe("resolveCliPathOwner", () => {
  const projects = [
    { id: 1, path: "/work/app" },
    { id: 2, path: "/work/app/packages/lib" },
  ];

  it("picks the deepest project and returns the relative path", () => {
    expect(resolveCliPathOwner("/work/app/packages/lib/src/x.ts", projects, [])).toEqual({
      projectId: 2,
      featureId: null,
      root: "/work/app/packages/lib",
      relativePath: "src/x.ts",
    });
  });

  it("lets a worktree nested in its checkout claim its files", () => {
    const worktrees = [{ projectId: 1, featureId: 7, path: "/work/app/.worktrees/fix" }];
    expect(resolveCliPathOwner("/work/app/.worktrees/fix/a.ts", projects, worktrees)).toMatchObject(
      { projectId: 1, featureId: 7, relativePath: "a.ts" },
    );
  });

  it("finds nothing outside every project", () => {
    expect(resolveCliPathOwner("/tmp/x", projects, [])).toBeNull();
  });
});

describe("chooseCheckoutFeature", () => {
  const features = [
    { id: 1, projectId: 1, lastActivityAt: "2026-11-01T10:00:00Z" },
    { id: 2, projectId: 1, lastActivityAt: "2026-11-10T10:00:00Z" },
    { id: 3, projectId: 1, lastActivityAt: "2026-11-11T10:00:00Z" },
  ];

  it("prefers the conversation this device last opened", () => {
    expect(chooseCheckoutFeature(features, new Set(), 1)).toBe(1);
  });

  it("skips conversations working in their own worktree", () => {
    expect(chooseCheckoutFeature(features, new Set([3]), 3)).toBe(2);
  });

  it("returns null when none works in the checkout", () => {
    expect(chooseCheckoutFeature(features, new Set([1, 2, 3]), null)).toBeNull();
  });
});

function sources(overrides: Partial<CliOpenSources> = {}): CliOpenSources {
  const worktrees: Record<number, CliRecordedWorktree[]> = {
    1: [
      { featureId: 11, path: "/wt/app/fix", live: true, isMainWorktree: false },
      { featureId: 12, path: "/wt/app/gone", live: false, isMainWorktree: false },
      { featureId: 13, path: "/work/app", live: true, isMainWorktree: true },
    ],
  };
  return {
    projects: () => Promise.resolve([{ id: 1, name: "app", path: "/work/app" }]),
    worktrees: (projectId) => Promise.resolve(worktrees[projectId] ?? []),
    activeFeatures: () =>
      Promise.resolve([
        { id: 11, projectId: 1, lastActivityAt: "2026-11-11T00:00:00Z" },
        { id: 12, projectId: 1, lastActivityAt: "2026-11-11T00:00:00Z" },
        { id: 13, projectId: 1, lastActivityAt: "2026-11-01T00:00:00Z" },
      ]),
    lastOpenedFeatureId: () => null,
    ...overrides,
  };
}

describe("planCliOpen", () => {
  it("opens the project for one of its folders", async () => {
    expect(await planCliOpen({ path: "/work/app/src", pathKind: "directory" }, sources())).toEqual({
      kind: "project",
      projectId: 1,
    });
  });

  it("opens a worktree file in its own conversation", async () => {
    expect(
      await planCliOpen({ path: "/wt/app/fix/a.ts", pathKind: "file", line: 4 }, sources()),
    ).toEqual({
      kind: "feature",
      projectId: 1,
      featureId: 11,
      file: { relativePath: "a.ts", line: 4 },
    });
  });

  it("opens a checkout file in a conversation working in the checkout", async () => {
    expect(await planCliOpen({ path: "/work/app/README.md", pathKind: "file" }, sources())).toEqual(
      {
        kind: "feature",
        projectId: 1,
        featureId: 13,
        file: { relativePath: "README.md", line: undefined },
      },
    );
  });

  it("explains when no conversation works in the checkout", async () => {
    const plan = await planCliOpen(
      { path: "/work/app/README.md", pathKind: "file" },
      sources({ activeFeatures: () => Promise.resolve([]) }),
    );
    expect(plan).toMatchObject({ kind: "project", notice: expect.stringMatching(/Start a/) });
  });

  it("explains a worktree of an archived conversation", async () => {
    const plan = await planCliOpen(
      { path: "/wt/app/fix/a.ts", pathKind: "file" },
      sources({ activeFeatures: () => Promise.resolve([]) }),
    );
    expect(plan).toMatchObject({ kind: "project", notice: expect.stringMatching(/archived/) });
  });

  it("reports a path outside every project", async () => {
    expect(await planCliOpen({ path: "/tmp/a", pathKind: "file" }, sources())).toEqual({
      kind: "not-in-project",
    });
  });

  it("lists worktrees only for the projects whose checkout holds the path", async () => {
    const asked: number[] = [];
    const twoProjects = sources({
      projects: () =>
        Promise.resolve([
          { id: 1, name: "app", path: "/work/app" },
          { id: 2, name: "site", path: "/work/site" },
        ]),
      worktrees: (projectId) => {
        asked.push(projectId);
        return Promise.resolve([]);
      },
    });
    await planCliOpen({ path: "/work/app/src", pathKind: "directory" }, twoProjects);
    expect(asked).toEqual([1]);
    asked.length = 0;
    await planCliOpen({ path: "/wt/elsewhere/a.ts", pathKind: "file" }, twoProjects);
    expect(asked.sort()).toEqual([1, 2]);
  });
});
