import { describe, it, expect } from "vitest";
import { presentableDiff } from "@codemirror/merge";
import { computeGitLineMarkers, type GitLineMarker } from "../diff-to-markers";

/**
 * Drive the marker computation through the real `presentableDiff` so the test
 * exercises the same change shape the editor produces at runtime.
 */
function markers(baseline: string, current: string): GitLineMarker[] {
  return computeGitLineMarkers(baseline, current, presentableDiff(baseline, current));
}

describe("computeGitLineMarkers", () => {
  it("returns no markers when the buffer matches the baseline", () => {
    expect(markers("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
  });

  it("returns no markers for an empty diff against itself", () => {
    expect(computeGitLineMarkers("x", "x", [])).toEqual([]);
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
});
