import { describe, expect, it } from "vitest";
import { notchActionKind, notchActionLabel, plainPreview, shortenPaths } from "./notch-action";

describe("notchActionKind", () => {
  it("classifies tools by family across providers", () => {
    expect(notchActionKind("Bash", '{"command":"ls"}')).toBe("bash");
    expect(notchActionKind("exec_command", "{}")).toBe("bash");
    expect(notchActionKind("Edit", "{}")).toBe("edit");
    expect(notchActionKind("Write", "{}")).toBe("edit");
    expect(notchActionKind("Grep", "{}")).toBe("search");
    expect(notchActionKind("WebFetch", "{}")).toBe("web");
    expect(notchActionKind("Agent", "{}")).toBe("agent");
    expect(notchActionKind("mcp__cadencr-browser__browser_open_url", "{}")).toBe("mcp");
    expect(notchActionKind("SomethingNew", "{}")).toBe("tool");
  });
});

describe("notchActionLabel", () => {
  it("reuses the stream's activity label on one line", () => {
    expect(notchActionLabel("Bash", JSON.stringify({ command: "pnpm\n  test" }))).toBe(
      "Running command: pnpm test",
    );
  });

  it("keeps only the tail of long absolute paths", () => {
    const label = notchActionLabel(
      "Read",
      JSON.stringify({ file_path: "/Users/me/code/app/src/notch/NotchIsland.tsx" }),
    );
    expect(label).toContain("…/notch/NotchIsland.tsx");
    expect(label).not.toContain("/Users/me");
  });

  it("caps the label length", () => {
    const label = notchActionLabel("Bash", JSON.stringify({ command: "x".repeat(400) }));
    expect(label.length).toBeLessThanOrEqual(160);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("shortenPaths", () => {
  it("leaves short paths alone", () => {
    expect(shortenPaths("cat src/main.rs")).toBe("cat src/main.rs");
  });
});

describe("plainPreview", () => {
  it("strips markdown noise and keeps the words", () => {
    expect(
      plainPreview("## Implemented\n- Added **bon** to [the crate](file:///x/Cargo.toml).\n`ok`"),
    ).toBe("Implemented Added bon to the crate. ok");
  });

  it("flattens tables", () => {
    expect(plainPreview("| Crate | Change |\n| --- | --- |\n| a | b |")).toBe(
      "Crate · Change · a · b",
    );
  });
});
