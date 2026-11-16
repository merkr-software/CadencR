import { describe, it, expect } from "vitest";
import { computeGitLineMarkers, toEditorLineBreaks, type GitLineMarker } from "../diff-to-markers";

function markers(baseline: string, current: string): GitLineMarker[] {
  return computeGitLineMarkers(baseline, current);
}

describe("computeGitLineMarkers", () => {
  it("returns no markers when the buffer matches the baseline", () => {
    expect(markers("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
  });

  it("returns no markers for an empty diff against itself", () => {
    expect(computeGitLineMarkers("x", "x")).toEqual([]);
  });

  it("marks an appended line as added", () => {
    const result = markers("a\nb\n", "a\nb\nc\n");
    expect(result).toEqual([{ line: 3, kind: "added" }]);
  });

  it("marks multiple inserted lines as added", () => {
    const result = markers("a\nd\n", "a\nb\nc\nd\n");
    expect(result).toContainEqual({ line: 2, kind: "added" });
    expect(result).toContainEqual({ line: 3, kind: "added" });
    expect(result.every((m) => m.kind === "added")).toBe(true);
  });

  it("marks an in-place edit as modified", () => {
    const result = markers("hello world\nsecond\n", "hello there\nsecond\n");
    expect(result).toEqual([{ line: 1, kind: "modified" }]);
  });

  it("marks a removed line as deleted on the line that replaces it", () => {
    const result = markers("a\nb\nc\n", "a\nc\n");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("deleted");
    // The deletion anchors on the current line now sitting at the deletion point.
    expect(result[0].line).toBe(2);
  });

  it("returns markers sorted by line number", () => {
    const result = markers("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\n");
    const lines = result.map((m) => m.line);
    expect(lines).toEqual([...lines].sort((x, y) => x - y));
  });

  it("does not bleed a marker onto the untouched line after an insertion", () => {
    // Inserting a full line between a and b must not mark the original b line
    // (which only shifted down) as changed.
    const result = markers("a\nb\n", "a\nNEW\nb\n");
    expect(result).toEqual([{ line: 2, kind: "added" }]);
  });

  it("handles a baseline with no trailing newline", () => {
    const result = markers("a\nb", "a\nbc");
    expect(result).toEqual([{ line: 2, kind: "modified" }]);
  });

  describe("pure deletions", () => {
    // A character diff slid these removals to a word boundary inside the next
    // line, so they used to render as a modification of the surviving line.
    it("marks a removed indented line as deleted, not modified", () => {
      const baseline = [
        "    <Button",
        "      copiedLabel={copiedLabel}",
        "      className={cn(className)}",
        "    />",
        "",
      ].join("\n");
      const current = ["    <Button", "      className={cn(className)}", "    />", ""].join("\n");
      expect(markers(baseline, current)).toEqual([{ line: 2, kind: "deleted" }]);
    });

    it("marks several removed lines as one deleted marker", () => {
      const baseline =
        'import {\n  CommentForm,\n  CommentDisplay,\n  CommentWidgetLine,\n} from "x";\n';
      const current = 'import {\n  CommentWidgetLine,\n} from "x";\n';
      expect(markers(baseline, current)).toEqual([{ line: 2, kind: "deleted" }]);
    });

    it("marks a deletion at the start of the file on the new first line", () => {
      expect(markers("a\nb\nc\n", "b\nc\n")).toEqual([{ line: 1, kind: "deleted" }]);
    });

    it("marks a deletion at the end of the file", () => {
      expect(markers("a\nb\nc\n", "a\nb\n")).toEqual([{ line: 3, kind: "deleted" }]);
    });

    it("marks a deletion of the last line without a trailing newline", () => {
      expect(markers("a\nb\nc", "a\nb")).toEqual([{ line: 2, kind: "deleted" }]);
    });

    it("marks the removal of one of several identical lines as deleted", () => {
      expect(markers("x\nx\nx\n", "x\nx\n")).toEqual([{ line: 3, kind: "deleted" }]);
    });

    it("keeps a modified last line when the lines after it were deleted", () => {
      expect(markers("a\nb\nc", "a\nB")).toEqual([{ line: 2, kind: "modified" }]);
    });
  });

  it("marks a deletion paired with an addition in the same hunk as modified", () => {
    expect(markers("a\nb\nc\nd\n", "a\nX\nd\n")).toEqual([{ line: 2, kind: "modified" }]);
  });

  it("marks a duplicated neighbouring line as added", () => {
    const baseline = "  foo={foo}\n  bar={bar}\n";
    const current = "  foo={foo}\n  foo={foo}\n  bar={bar}\n";
    // Either copy is a valid answer; what matters is one whole added line.
    const result = markers(baseline, current);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("added");
  });

  it("marks a line appended to a file without a trailing newline as added", () => {
    expect(markers("a\nb", "a\nb\nc")).toEqual([{ line: 3, kind: "added" }]);
  });

  it("numbers the lines of hunks far apart in a long file", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const current = [...lines.slice(0, 9), ...lines.slice(10, 150), "NEW", ...lines.slice(150)];
    expect(markers(lines.join("\n"), current.join("\n"))).toEqual([
      { line: 10, kind: "deleted" },
      { line: 150, kind: "added" },
    ]);
  });

  it("aligns a change on a line that shares its start and end with the baseline", () => {
    // The character prefix (`foo(`) and suffix (`);`) are shared, the line is not.
    expect(markers("a\nfoo(1);\nb\n", "a\nfoo(2);\nb\n")).toEqual([{ line: 2, kind: "modified" }]);
  });

  describe("more distinct lines than the diff can encode", () => {
    const distinct = (tag: string): string =>
      Array.from({ length: 70_000 }, (_, i) => `${tag}${i}`).join("\n");

    it("still marks the rewritten lines as modified", () => {
      const result = markers(`head\n${distinct("a")}\ntail`, `head\n${distinct("b")}\ntail`);
      expect(result).toHaveLength(70_000);
      expect(result[0]).toEqual({ line: 2, kind: "modified" });
      expect(result.at(-1)).toEqual({ line: 70_001, kind: "modified" });
    });

    it("still marks the removed lines as deleted", () => {
      expect(markers(`head\n${distinct("a")}\ntail`, "head\ntail")).toEqual([
        { line: 2, kind: "deleted" },
      ]);
    });
  });

  it("keeps hundreds of scattered edits line-exact", () => {
    // A rename or find-and-replace across a long file must not fall back to
    // marking the whole region between the first and last edit.
    const lines = Array.from({ length: 20_000 }, (_, i) => `const value${i} = ${i};`);
    const current = lines.map((line, i) => (i % 50 === 0 ? `${line} // renamed` : line));
    const result = markers(lines.join("\n"), current.join("\n"));
    expect(result).toHaveLength(400);
    expect(result.every((marker) => marker.kind === "modified")).toBe(true);
  });

  describe("line counting", () => {
    it("reads a CRLF baseline the way the editor holds the file", () => {
      const baseline = toEditorLineBreaks("one\r\ntwo\r\nthree\r\n");
      expect(markers(baseline, "one\ntwo\nthree\n")).toEqual([]);
      expect(markers(baseline, "one\nthree\n")).toEqual([{ line: 2, kind: "deleted" }]);
      // The editor also breaks lines on a lone `\r`.
      expect(toEditorLineBreaks("a\rb")).toBe("a\nb");
    });

    it("marks every line of a file whose baseline is empty as added", () => {
      expect(markers("", "x")).toEqual([{ line: 1, kind: "added" }]);
      expect(markers("", "x\ny\n")).toEqual([
        { line: 1, kind: "added" },
        { line: 2, kind: "added" },
      ]);
    });

    it("marks emptying a file as one deletion", () => {
      expect(markers("x\ny", "")).toEqual([{ line: 1, kind: "deleted" }]);
      expect(markers("x\ny\n", "")).toEqual([{ line: 1, kind: "deleted" }]);
    });

    it("marks typing on the empty last line as an added line", () => {
      expect(markers("a\n", "a\nb")).toEqual([{ line: 2, kind: "added" }]);
      expect(markers("a\nb\n", "a\nb\nc")).toEqual([{ line: 3, kind: "added" }]);
    });

    it("draws no marker for a trailing line break added or removed alone", () => {
      expect(markers("a\nb", "a\nb\n")).toEqual([]);
      expect(markers("a\nb\n", "a\nb")).toEqual([]);
    });
  });
});
