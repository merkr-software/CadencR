import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, langFromPath, hasTextHunks, isBinaryPatch } from "./parse-unified-diff";

const SINGLE_FILE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc123..def456 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
-removed line`;

const MULTI_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old2
+new2`;

describe("parseUnifiedDiff", () => {
  it("returns empty array for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("   ")).toEqual([]);
  });

  it("parses a single file diff", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_DIFF);
    expect(result).toHaveLength(1);
    expect(result[0].oldFileName).toBe("src/foo.ts");
    expect(result[0].newFileName).toBe("src/foo.ts");
    expect(result[0].hunks).toHaveLength(1);
    expect(result[0].hunks[0]).toContain("diff --git");
    expect(result[0].hunks[0]).toContain("+added line");
  });

  it("parses multi-file diff", () => {
    const result = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(result).toHaveLength(2);
    expect(result[0].oldFileName).toBe("src/a.ts");
    expect(result[1].oldFileName).toBe("src/b.ts");
  });

  it("strips a/ and b/ prefixes from file names", () => {
    const result = parseUnifiedDiff(SINGLE_FILE_DIFF);
    expect(result[0].oldFileName.startsWith("a/")).toBe(false);
    expect(result[0].newFileName.startsWith("b/")).toBe(false);
  });

  it("handles new file (--- /dev/null)", () => {
    const newFileDiff = `diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+new content`;
    const result = parseUnifiedDiff(newFileDiff);
    expect(result).toHaveLength(1);
    expect(result[0].oldFileName).toBe("/dev/null");
    expect(result[0].newFileName).toBe("new.ts");
  });

  it("handles deleted file (+++ /dev/null)", () => {
    const deletedFileDiff = `diff --git a/old.ts b/old.ts
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-deleted content`;
    const result = parseUnifiedDiff(deletedFileDiff);
    expect(result).toHaveLength(1);
    expect(result[0].newFileName).toBe("/dev/null");
  });

  it("skips content before first diff --git header", () => {
    const withPreamble = `some preamble text\nnot a diff\n${SINGLE_FILE_DIFF}`;
    const result = parseUnifiedDiff(withPreamble);
    expect(result).toHaveLength(1);
  });

  it("keeps binary/no-hunk files so the Git tab can show placeholders", () => {
    const noHunkDiff = `diff --git a/image.png b/image.png
--- a/image.png
+++ b/image.png
Binary files a/image.png and b/image.png differ`;
    const result = parseUnifiedDiff(noHunkDiff);
    expect(result).toHaveLength(1);
    expect(result[0].newFileName).toBe("image.png");
    expect(hasTextHunks(result[0])).toBe(false);
  });

  it("keeps mode-only changes without hunks alongside valid diffs", () => {
    const mixed = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new`;
    const result = parseUnifiedDiff(mixed);
    expect(result).toHaveLength(2);
    expect(result[0].newFileName).toBe("script.sh");
    expect(hasTextHunks(result[0])).toBe(false);
    expect(result[1].newFileName).toBe("src/a.ts");
    expect(hasTextHunks(result[1])).toBe(true);
  });
});

describe("langFromPath", () => {
  it.each([
    ["foo.ts", "typescript"],
    ["foo.tsx", "tsx"],
    ["foo.js", "javascript"],
    ["foo.jsx", "jsx"],
    ["foo.json", "json"],
    ["foo.css", "css"],
    ["foo.md", "markdown"],
    ["foo.py", "python"],
    ["foo.rs", "rust"],
    ["foo.go", "go"],
    ["foo.yml", "yaml"],
    ["foo.yaml", "yaml"],
    ["foo.sh", "shell"],
    ["foo.sql", "sql"],
    ["foo.html", "xml"],
    ["foo.xml", "xml"],
  ])("returns %s lang for %s", (path, expected) => {
    expect(langFromPath(path)).toBe(expected);
  });

  it("returns plaintext for unknown extensions", () => {
    expect(langFromPath("foo.xyz")).toBe("plaintext");
  });

  it("returns makefile lang for Makefile", () => {
    expect(langFromPath("Makefile")).toBe("makefile");
  });

  it("is case-insensitive for extensions", () => {
    expect(langFromPath("foo.TS")).toBe("typescript");
  });
});

describe("isBinaryPatch", () => {
  it("detects standard binary file diff markers in the header", () => {
    expect(
      isBinaryPatch(
        "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n",
      ),
    ).toBe(true);
    expect(isBinaryPatch("diff --git a/blob.bin b/blob.bin\nGIT binary patch\nliteral 4\n")).toBe(
      true,
    );
  });

  it("returns false for normal text diffs and ignores markers past the 4 KB header window", () => {
    expect(isBinaryPatch(SINGLE_FILE_DIFF)).toBe(false);
    const bodyPastHeader = `${SINGLE_FILE_DIFF}\n+${"x".repeat(5000)}\nGIT binary patch\n`;
    expect(isBinaryPatch(bodyPastHeader)).toBe(false);
  });
});
