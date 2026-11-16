import { describe, expect, it } from "vitest";
import { FileStageState, type ChangedFile } from "@/api/generated";
import { gitDiffTreeFiles, gitDiffTreePath, realGitDiffTreePath } from "./gitDiffTreePath";

const file = (path: string): ChangedFile => ({
  file: path,
  status: "M",
  additions: 1,
  deletions: 0,
  stage_state: FileStageState.unstaged,
});

describe("gitDiffTreePath", () => {
  it("escapes each segment, so folders stay folders", () => {
    expect(gitDiffTreePath("src/ok.ts")).toBe("src/ok.ts");
    expect(gitDiffTreePath("dir\tx/a\nb.txt")).toBe('"dir\\tx"/"a\\nb.txt"');
  });

  it("maps file and folder tree paths back to the real ones", () => {
    for (const real of ["src/ok.ts", "dir\tx", "dir\tx/a\nb.txt", 'q"/x\\y']) {
      expect(realGitDiffTreePath(gitDiffTreePath(real))).toBe(real);
    }
  });

  it("keeps the files array when no name needs escaping", () => {
    const plain = [file("a.ts"), file("src/b.ts")];
    expect(gitDiffTreeFiles(plain)).toBe(plain);
    expect(gitDiffTreeFiles([file("a\nb.txt")]).map((f) => f.file)).toEqual(['"a\\nb.txt"']);
  });
});
