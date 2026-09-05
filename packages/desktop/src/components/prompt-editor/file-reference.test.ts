import { describe, expect, it } from "vitest";
import { fileReferenceHref, parseFileReferenceHref, parseFileReferences } from "./file-reference";

describe("parseFileReferences", () => {
  it("finds a bare relative path with a recognized extension", () => {
    const matches = parseFileReferences("see src/main.rs for the entry point");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: "src/main.rs", line: undefined, col: undefined });
  });

  it("finds a path with a line number", () => {
    const matches = parseFileReferences("check src/main.rs:42");
    expect(matches[0]).toMatchObject({ path: "src/main.rs", line: 42, col: undefined });
  });

  it("finds a path with a line and column", () => {
    const matches = parseFileReferences("error at src/main.rs:42:7");
    expect(matches[0]).toMatchObject({ path: "src/main.rs", line: 42, col: 7 });
  });

  it("finds a single filename with no directory", () => {
    const matches = parseFileReferences("edit README.md next");
    expect(matches[0]).toMatchObject({ path: "README.md" });
  });

  it("finds multiple references in the same text", () => {
    const matches = parseFileReferences("compare src/a.ts:1 against src/b.ts:2");
    expect(matches.map((m) => m.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does not match a version-like token", () => {
    expect(parseFileReferences("upgrade to v1.2.3")).toHaveLength(0);
  });

  it("does not match an aspect ratio or a URL with a port", () => {
    expect(parseFileReferences("a 16:9 image")).toHaveLength(0);
    expect(parseFileReferences("see http://example.com:8080/path")).toHaveLength(0);
  });

  it("does not match an unrecognized extension", () => {
    expect(parseFileReferences("open notes.xyz123")).toHaveLength(0);
  });

  it("does not match past a trailing identifier character", () => {
    // "foo.tsx2" is not a reference to "foo.tsx" — the match must not stop
    // short of a token boundary.
    expect(parseFileReferences("import foo.tsx2 from somewhere")).toHaveLength(0);
  });

  it("reports character offsets so a caller can splice the match out", () => {
    const text = "see src/main.rs:42 now";
    const matches = parseFileReferences(text);
    expect(text.slice(matches[0].start, matches[0].end)).toBe("src/main.rs:42");
  });
});

describe("fileReferenceHref / parseFileReferenceHref", () => {
  it("round-trips a path with a line and column", () => {
    const href = fileReferenceHref("src/main.rs", 42, 7);
    const parsed = parseFileReferenceHref(href);
    expect(parsed).toEqual({ path: "src/main.rs", line: 42, col: 7 });
  });

  it("round-trips a path with no line or column", () => {
    const href = fileReferenceHref("README.md");
    const parsed = parseFileReferenceHref(href);
    expect(parsed).toEqual({ path: "README.md", line: undefined, col: undefined });
  });

  it("round-trips a path with special characters", () => {
    const href = fileReferenceHref("src/a file (copy).ts", 3);
    const parsed = parseFileReferenceHref(href);
    expect(parsed?.path).toBe("src/a file (copy).ts");
    expect(parsed?.line).toBe(3);
  });

  it("returns null for an href using a different scheme", () => {
    expect(parseFileReferenceHref("cadencr-conversation:feature/1")).toBeNull();
    expect(parseFileReferenceHref("https://example.com")).toBeNull();
  });
});
