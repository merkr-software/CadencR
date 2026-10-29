import { describe, expect, it } from "vitest";
import type { Feature, PrStatusSnapshot } from "@/api/generated";
import {
  hasActivityItems,
  hasCodeItems,
  rowMetaItems,
  rowMetaPart,
  type RowMetaInput,
  type RowMetaItems,
} from "./sidebar-row-meta";

const items: RowMetaItems = {
  branch: "feat/dark-mode",
  label: "bug",
  model: "opus",
  stats: { insertions: 3, deletions: 1 } as RowMetaItems["stats"],
  pr: true,
  activity: true,
  ports: true,
  todos: { preview: null, todos: { done: 1, total: 3 }, error: null },
};

describe("rowMetaPart", () => {
  it("keeps the branch, diff and pull request on the code line", () => {
    const code = rowMetaPart(items, "code");
    expect(hasCodeItems(code)).toBe(true);
    expect(hasActivityItems(code)).toBe(false);
  });

  it("keeps the label, todos, activity, ports and model on the activity line", () => {
    const activity = rowMetaPart(items, "activity");
    expect(hasActivityItems(activity)).toBe(true);
    expect(hasCodeItems(activity)).toBe(false);
  });

  it("keeps every item without a part", () => {
    expect(rowMetaPart(items, undefined)).toBe(items);
  });
});

describe("rowMetaItems", () => {
  const show = {
    branch: false,
    label: "hidden",
    diff: false,
    pr: true,
    activity: false,
    ports: false,
    provider: "logo",
    todos: false,
  } as const;
  const input = (prStatus: Partial<PrStatusSnapshot>): RowMetaInput => ({
    feature: { id: 1, label: null, runtime_provider: null } as unknown as Feature,
    worktree: undefined,
    prStatus: { pr: null, other_prs: [], ...prStatus } as PrStatusSnapshot,
    gitStats: undefined,
    shellCount: 0,
    browserCount: 0,
    downloadCount: 0,
    ports: [],
  });

  it("shows a forge error without a proposal, as the indicator does", () => {
    expect(rowMetaItems(show, input({ error: "auth failed" })).pr).toBe(true);
  });

  it("leaves a forge that needs setting up to the Git tab, as the indicator does", () => {
    expect(rowMetaItems(show, input({ error: "no token", setup_required: true })).pr).toBe(false);
  });
});
