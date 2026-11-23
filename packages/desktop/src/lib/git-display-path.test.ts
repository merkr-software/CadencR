import { describe, expect, it } from "vitest";
import {
  displayGitPath,
  displayGitTreePath,
  parseGitDisplayPath,
  parseGitTreePath,
} from "./git-display-path";

describe("displayGitPath", () => {
  it("leaves an ordinary path, spaces and non-ASCII included, as it is", () => {
    expect(displayGitPath("src/my file é.ts")).toBe("src/my file é.ts");
  });

  it("quotes and escapes a path holding a control character, as git does", () => {
    expect(displayGitPath("a\nb.txt")).toBe('"a\\nb.txt"');
    expect(displayGitPath("tab\there\r")).toBe('"tab\\there\\r"');
    expect(displayGitPath("bell\u0007\u0001")).toBe('"bell\\a\\001"');
  });

  it("escapes a C1 control character as git writes its UTF-8 bytes", () => {
    expect(displayGitPath("a\u0085b.txt")).toBe('"a\\302\\205b.txt"');
    expect(displayGitPath("\u0080\u009f")).toBe('"\\302\\200\\302\\237"');
    // The first non-C1 code points after the range stay as they are.
    expect(displayGitPath("\u00a0é")).toBe("\u00a0é");
  });

  it("escapes quotes and backslashes so a quoted name is never ambiguous", () => {
    expect(displayGitPath('say "hi"')).toBe('"say \\"hi\\""');
    expect(displayGitPath("a\\nb.txt")).toBe('"a\\\\nb.txt"');
    expect(displayGitPath("a\\nb.txt")).not.toBe(displayGitPath("a\nb.txt"));
  });

  it("reads every displayed name back to the real one", () => {
    const names = [
      "plain.ts",
      "a\nb.txt",
      'say "hi"',
      "a\\nb.txt",
      "bell\u0007\u0001\u007f",
      "a\u0085b.txt",
      "\u0001\u0080é\u009f\n",
      "é\u0085ü",
      '"',
      "\\",
      "",
    ];
    for (const name of names) expect(parseGitDisplayPath(displayGitPath(name))).toBe(name);
  });
});

describe("displayGitTreePath", () => {
  it("escapes each segment, so folders stay folders", () => {
    expect(displayGitTreePath("src/ok.ts")).toBe("src/ok.ts");
    expect(displayGitTreePath("dir\tx/a\nb.txt")).toBe('"dir\\tx"/"a\\nb.txt"');
  });

  it("maps file and folder tree paths back to the real ones", () => {
    for (const real of ["src/ok.ts", "dir\tx", "dir\tx/a\nb.txt", 'q"/x\\y', "c1\u0085/é"]) {
      expect(parseGitTreePath(displayGitTreePath(real))).toBe(real);
    }
  });
});
