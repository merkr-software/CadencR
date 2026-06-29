import { describe, it, expect } from "vitest";
import { render } from "@/test-utils";
import type { FileDiffSection } from "@/lib/parse-unified-diff";
import { DiffStatusIcon, deriveChangeType } from "./DiffStatusIcon";

const section = (oldFileName: string, newFileName: string): FileDiffSection => ({
  oldFileName,
  newFileName,
  hunks: [],
});

describe("deriveChangeType", () => {
  it("maps an added file (old is /dev/null)", () => {
    expect(deriveChangeType(section("/dev/null", "a.ts"))).toBe("new");
  });

  it("maps a deleted file (new is /dev/null)", () => {
    expect(deriveChangeType(section("a.ts", "/dev/null"))).toBe("deleted");
  });

  it("maps a renamed file (different names)", () => {
    expect(deriveChangeType(section("a.ts", "b.ts"))).toBe("renamed");
  });

  it("defaults to a modification (same name)", () => {
    expect(deriveChangeType(section("a.ts", "a.ts"))).toBe("change");
  });
});

describe("DiffStatusIcon", () => {
  it("renders Pierre's glyph for the change type", () => {
    const { container } = render(<DiffStatusIcon type="new" appearance="dark" />);
    expect(container.querySelector('use[href="#diffs-icon-symbol-added"]')).toBeInTheDocument();
  });
});
