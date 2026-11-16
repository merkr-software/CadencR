import { describe, expect, it } from "vitest";
import type { Feature, FeatureWorktreeInfo, Project } from "@/api/generated";
import type { LensContext } from "@/lib/sidebar-lens";
import {
  applySidebarView,
  buildSidebarGroups,
  isSidebarListReorderable,
  parseSidebarViewQuery,
  parseSidebarViews,
  sidebarListMode,
} from "@/lib/sidebar-views";

const NOW = Date.UTC(2026, 9, 12, 12);
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const projects: Project[] = [
  { id: 1, name: "web-app", path: "/w", created_at: minutesAgo(9999) },
  { id: 2, name: "billing-api", path: "/b", created_at: minutesAgo(9999) },
] as Project[];

function feature(id: number, overrides: Partial<Feature> = {}): Feature {
  return {
    id,
    project_id: 1,
    title: `Conversation ${id}`,
    status: "active",
    type: "ws-session",
    is_pinned: false,
    created_at: minutesAgo(1000 + id),
    last_activity_at: minutesAgo(id * 10),
    ...overrides,
  };
}

const features = [
  feature(1, { title: "Fix login", label: "bug", runtime_provider: "claude_code" }),
  feature(2, { project_id: 2, runtime_provider: "codex", is_pinned: true }),
  feature(3, { title: "Refactor billing", label: "Infra", runtime_provider: "codex" }),
  feature(4, { title: "Old notes" }),
];

const states: Record<number, "waiting" | "failed"> = { 2: "waiting", 3: "failed" };
const worktrees = new Map<number, FeatureWorktreeInfo>([
  [3, { feature_id: 3, is_main_worktree: false, worktree_branch: "refactor" }],
] as [number, FeatureWorktreeInfo][]);
const context: LensContext = {
  stateOf: (id) => states[id] ?? "idle",
  worktreeOf: (id) => worktrees.get(id),
  now: NOW,
};

const show = (query: string) =>
  applySidebarView(features, parseSidebarViewQuery(query, projects), context).map((f) => f.id);

describe("sidebar views", () => {
  it("shows everything for an empty query", () => {
    expect(show("")).toEqual([1, 2, 3, 4]);
  });

  it("reads the Agents grid keys: project, pin, exclude, last and free text", () => {
    expect(show("/project:billing-api")).toEqual([2]);
    expect(show("/pin:")).toEqual([2]);
    expect(show('/exclude:"Fix login"')).toEqual([2, 3, 4]);
    // Within 25 minutes, or still waiting on the user (2 is 20 minutes old anyway).
    expect(show("/last:25")).toEqual([1, 2]);
    expect(show("billing")).toEqual([3]);
  });

  it("adds the sidebar keys: status, label, provider and worktree", () => {
    expect(show("/status:waiting|failed")).toEqual([2, 3]);
    expect(show("/label:infra|none")).toEqual([2, 3, 4]);
    expect(show("/provider:claude")).toEqual([1]);
    expect(show("/worktree:yes")).toEqual([3]);
    expect(show("/worktree:no /provider:codex")).toEqual([2]);
  });

  it("orders by the view's /sort:, else keeps the given order", () => {
    expect(show("/sort:created")).toEqual([1, 2, 3, 4]);
    expect(show("/sort:-created")).toEqual([4, 3, 2, 1]);
    const reversed = [...features].reverse();
    const view = (query: string) =>
      applySidebarView(reversed, parseSidebarViewQuery(query, projects), context).map((f) => f.id);
    expect(view("")).toEqual([4, 3, 2, 1]);
    expect(view("/sort:activity")).toEqual([1, 2, 3, 4]);
  });

  it("excludes titles containing an /exclude: value, as the Agents grid does", () => {
    expect(show("/exclude:login")).toEqual([2, 3, 4]);
  });

  it("reads SQLite's UTC timestamps (no zone suffix) for /last:", () => {
    const sqlite = (minutes: number) => minutesAgo(minutes).slice(0, 19).replace("T", " ");
    const recent = [
      feature(5, { last_activity_at: sqlite(20) }),
      feature(6, { last_activity_at: sqlite(40) }),
    ];
    const shown = applySidebarView(recent, parseSidebarViewQuery("/last:30", projects), context);
    expect(shown.map((f) => f.id)).toEqual([5]);
  });
});

describe("buildSidebarGroups", () => {
  it("leaves pinned conversations to the Pinned block in a lens, not in a view", () => {
    const lens = sidebarListMode("flat", null);
    const view = sidebarListMode("flat", { id: "v", name: "Codex", query: "/provider:codex" });
    if (lens.kind === "tree" || view.kind === "tree") throw new Error("expected a list");
    const ids = (groups: ReturnType<typeof buildSidebarGroups>) =>
      groups.flatMap((group) => group.features.map((f) => f.id));
    expect(ids(buildSidebarGroups(features, lens, "activity", [], projects, context))).toEqual([
      1, 3, 4,
    ]);
    expect(ids(buildSidebarGroups(features, view, "activity", [], projects, context))).toEqual([
      2, 3,
    ]);
    expect(sidebarListMode("project", null)).toEqual({ kind: "tree" });
  });

  it("orders every lens group by the manual rank", () => {
    const lens = sidebarListMode("flat", null);
    if (lens.kind === "tree") throw new Error("expected a list");
    const [group] = buildSidebarGroups(features, lens, "manual", [4, 3, 1], projects, context);
    expect(group?.features.map((f) => f.id)).toEqual([4, 3, 1]);
  });
});

describe("isSidebarListReorderable", () => {
  it("refuses a view that sorts itself", () => {
    const lens = sidebarListMode("status", null);
    const plain = sidebarListMode("flat", { id: "v", name: "All", query: "/provider:codex" });
    const sorted = sidebarListMode("flat", { id: "s", name: "New", query: "/sort:created" });
    if (lens.kind === "tree" || plain.kind === "tree" || sorted.kind === "tree") {
      throw new Error("expected a list");
    }
    expect(isSidebarListReorderable(lens, projects)).toBe(true);
    expect(isSidebarListReorderable(plain, projects)).toBe(true);
    expect(isSidebarListReorderable(sorted, projects)).toBe(false);
  });
});

describe("parseSidebarViews", () => {
  it("reads the saved list and reports a broken one", () => {
    expect(parseSidebarViews('[{"id":"a","name":"Mine","query":"/pin:"}]').views).toEqual([
      { id: "a", name: "Mine", query: "/pin:" },
    ]);
    expect(parseSidebarViews(null)).toEqual({ views: [], error: null });
    expect(parseSidebarViews("{").error).not.toBeNull();
    expect(parseSidebarViews('[{"name":1}]').error).not.toBeNull();
  });
});
