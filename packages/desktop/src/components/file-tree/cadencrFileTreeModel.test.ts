import { describe, expect, it } from "vitest";
import { gitStatusFromUncommittedFiles } from "./cadencrFileTreeModel";

const files = [
  { path: "packages/app/src/a.ts", change_kind: "modified" },
  { path: "packages/app/new.ts", change_kind: "untracked" },
  { path: "README.md", change_kind: "modified" },
];

describe("gitStatusFromUncommittedFiles", () => {
  it("decorates a monorepo subdirectory's files at their tree paths", () => {
    expect(gitStatusFromUncommittedFiles(files, "packages/app")).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "new.ts", status: "untracked" },
    ]);
  });

  it("keeps checkout paths for a project at the repository root", () => {
    expect(gitStatusFromUncommittedFiles(files, "")).toHaveLength(3);
  });

  it("decorates nothing until the Git prefix is known", () => {
    expect(gitStatusFromUncommittedFiles(files, undefined)).toEqual([]);
    expect(gitStatusFromUncommittedFiles(files, null)).toEqual([]);
  });
});
