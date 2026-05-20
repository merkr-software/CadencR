import { describe, expect, it } from "vitest";
import { firstChangedNewLine } from "./diff-line";

describe("firstChangedNewLine", () => {
  it("never returns line 0 for new-file diffs", () => {
    const patch = `diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+one
+two
`;

    expect(firstChangedNewLine(patch)).toBe(1);
  });

  it("falls back to line 1 for deletion-only diffs with no new-file range", () => {
    const patch = `diff --git a/src/deleted.ts b/src/deleted.ts
--- a/src/deleted.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;

    expect(firstChangedNewLine(patch)).toBe(1);
  });
});
