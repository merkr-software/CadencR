import { describe, expect, it } from "vitest";
import { displayGitPath, parseGitDisplayPath } from "./git-display-path";

describe("displayGitPath", () => {
  it("leaves an ordinary path, spaces and non-ASCII included, as it is", () => {
    expect(displayGitPath("src/my file é.ts")).toBe("src/my file é.ts");
  });

  it("quotes and escapes a path holding a control character, as git does", () => {
    expect(displayGitPath("a\nb.txt")).toBe('"a\\nb.txt"');
    expect(displayGitPath("tab\there\r")).toBe('"tab\\there\\r"');
    expect(displayGitPath("bell\u0007\u0001")).toBe('"bell\\a\\001"');
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
      '"',
      "\\",
      "",
    ];
    for (const name of names) expect(parseGitDisplayPath(displayGitPath(name))).toBe(name);
  });
});
