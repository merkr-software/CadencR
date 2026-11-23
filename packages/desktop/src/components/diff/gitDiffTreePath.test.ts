import { describe, expect, it } from "vitest";
import { FileStageState, type ChangedFile } from "@/api/generated";
import { gitDiffTreeFiles } from "./gitDiffTreePath";

const file = (path: string): ChangedFile => ({
  file: path,
  status: "M",
  additions: 1,
  deletions: 0,
  stage_state: FileStageState.unstaged,
});

describe("gitDiffTreeFiles", () => {
  it("keeps the files array when no name needs escaping", () => {
    const plain = [file("a.ts"), file("src/b.ts")];
    expect(gitDiffTreeFiles(plain)).toBe(plain);
    expect(gitDiffTreeFiles([file("a\nb.txt")]).map((f) => f.file)).toEqual(['"a\\nb.txt"']);
  });
});
