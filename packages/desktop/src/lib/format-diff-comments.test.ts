import { describe, it, expect } from "vitest";
import { formatCommentsForAgent } from "./format-diff-comments";
import { gitPathForAgent } from "./git-paths";

const asIs = (path: string): string => path;

describe("formatCommentsForAgent", () => {
  it("returns empty string for no comments", () => {
    expect(formatCommentsForAgent([], asIs)).toBe("");
  });

  it("formats a single comment", () => {
    const result = formatCommentsForAgent(
      [{ file_path: "src/main.ts", line_number: 10, content: "Fix this" }],
      asIs,
    );
    expect(result).toBe("## src/main.ts\n- Line 10: Fix this");
  });

  it("groups comments by file path", () => {
    const result = formatCommentsForAgent(
      [
        { file_path: "a.ts", line_number: 1, content: "first" },
        { file_path: "b.ts", line_number: 5, content: "second" },
        { file_path: "a.ts", line_number: 3, content: "third" },
      ],
      asIs,
    );
    expect(result).toBe("## a.ts\n- Line 1: first\n- Line 3: third\n## b.ts\n- Line 5: second");
  });

  it("names files the way an agent in a monorepo subdirectory resolves them", () => {
    const mapping = { prefix: "packages/app", root: "/repo" };
    const result = formatCommentsForAgent(
      [
        { file_path: "packages/app/src/a.ts", line_number: 2, content: "inside" },
        { file_path: "README.md", line_number: 1, content: "outside" },
        { file_path: "packages/app/src/a.ts", line_number: 7, content: "again" },
      ],
      (path) => gitPathForAgent(path, mapping),
    );
    expect(result).toBe(
      "## src/a.ts\n- Line 2: inside\n- Line 7: again\n## /repo/README.md\n- Line 1: outside",
    );
  });
});
