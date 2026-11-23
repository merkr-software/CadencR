import { describe, expect, it } from "vitest";
import {
  buildPierreInputs,
  fromPierrePath,
  gitStatusFromUncommittedFiles,
  toPierrePath,
  typedEntryName,
} from "./cadencrFileTreeModel";

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

describe("tree paths of names holding control characters", () => {
  const entries = [
    { path: "dir\tx", is_dir: true, is_gitignored: true },
    { path: "dir\tx/a\nb.txt", is_dir: false, is_gitignored: true },
    { path: "ok.ts", is_dir: false, is_gitignored: false },
  ];

  it("names each segment the way git prints it, so HTML can't fold it", () => {
    const { paths, ignoredRoots } = buildPierreInputs(entries);
    expect(paths).toEqual(['"dir\\tx"/', '"dir\\tx"/"a\\nb.txt"', "ok.ts"]);
    expect(ignoredRoots).toEqual(['"dir\\tx"/']);
  });

  it("maps every tree path back to the real one for actions", () => {
    const { paths } = buildPierreInputs(entries);
    expect(paths.map(fromPierrePath)).toEqual(entries.map((entry) => entry.path));
    expect(fromPierrePath(toPierrePath({ path: 'q"/x\\y\u0085', is_dir: false }))).toBe(
      'q"/x\\y\u0085',
    );
  });

  it("decorates a changed file at its tree path", () => {
    expect(
      gitStatusFromUncommittedFiles([{ path: "app/a\nb.txt", change_kind: "modified" }], "app"),
    ).toEqual([{ path: '"a\\nb.txt"', status: "modified" }]);
  });
});

describe("a name typed in the tree", () => {
  it("is taken as typed, never decoded as a git-escaped name", () => {
    expect(typedEntryName('dir/"draft"')).toBe('"draft"');
    expect(typedEntryName('dir/"a\\tb"/')).toBe('"a\\tb"');
  });

  it("keeps the real name when the displayed form was left unchanged", () => {
    expect(typedEntryName('dir/"a\\nb.txt"', "a\nb.txt")).toBe("a\nb.txt");
    expect(typedEntryName("dir/c.txt", "a\nb.txt")).toBe("c.txt");
  });
});
