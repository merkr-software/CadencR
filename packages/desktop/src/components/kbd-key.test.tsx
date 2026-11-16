import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import { KbdKeyContent, KbdKeySequence, resolveKbdKey } from "./kbd-key";

function glyphLabel(key: string, isMac: boolean): string | null {
  const resolved = resolveKbdKey(key, isMac);
  return resolved.kind === "glyph" ? resolved.glyph.label : null;
}

function text(key: string, isMac: boolean): string | null {
  const resolved = resolveKbdKey(key, isMac);
  return resolved.kind === "text" ? resolved.text : null;
}

describe("resolveKbdKey on macOS", () => {
  it.each([
    ["mod", "Command"],
    ["cmd", "Command"],
    ["⌘", "Command"],
    ["alt", "Option"],
    ["⌥", "Option"],
    ["ctrl", "Control"],
    ["⌃", "Control"],
    ["shift", "Shift"],
    ["⇧", "Shift"],
    ["enter", "Return"],
    ["↵", "Return"],
    ["backspace", "Delete"],
    ["⌫", "Delete"],
    ["↑", "Up"],
  ])("draws %s as the %s glyph", (key, label) => {
    expect(glyphLabel(key, true)).toBe(label);
  });

  it("prints letter mnemonics and F-keys as key caps", () => {
    expect(text("p", true)).toBe("P");
    expect(text("f12", false)).toBe("F12");
  });

  it("does not resolve arbitrary text through Object.prototype", () => {
    expect(text("constructor", true)).toBe("constructor");
    expect(text("toString", false)).toBe("toString");
  });

  it("keeps letters, digits and named keys as text", () => {
    expect(text("K", true)).toBe("K");
    expect(text("1", true)).toBe("1");
    expect(text("esc", true)).toBe("Esc");
    expect(text("Esc", true)).toBe("Esc");
    expect(text("Tab", true)).toBe("Tab");
    expect(text("F12", true)).toBe("F12");
    expect(text("1-9", true)).toBe("1-9");
  });
});

describe("resolveKbdKey on Linux", () => {
  it.each([
    ["mod", "Ctrl"],
    ["cmd", "Ctrl"],
    ["Ctrl", "Ctrl"],
    ["alt", "Alt"],
    ["Alt", "Alt"],
    ["shift", "Shift"],
    ["Shift", "Shift"],
    ["enter", "Enter"],
    ["Enter", "Enter"],
  ])("writes %s as the word %s", (key, word) => {
    expect(text(key, false)).toBe(word);
  });

  it("still draws backspace and arrows as glyphs", () => {
    expect(glyphLabel("⌫", false)).toBe("Backspace");
    expect(glyphLabel("down", false)).toBe("Down");
  });
});

describe("KbdKeyContent", () => {
  it("draws glyph keys as a hidden icon named by data-kbd-key", () => {
    const { container } = render(<KbdKeyContent keyName="shift" isMac />);
    expect(container.querySelector('[data-kbd-key="Shift"] svg')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("renders words on Linux", () => {
    const { container } = render(<KbdKeyContent keyName="shift" isMac={false} />);
    expect(screen.getByText("Shift")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("KbdKeySequence", () => {
  it("runs macOS glyphs together", () => {
    const { container } = render(<KbdKeySequence keys={["⌘", "C"]} isMac />);
    expect(container.querySelector('[data-kbd-key="Command"]')).toBeInTheDocument();
    expect(container.textContent).toBe("C");
  });

  it("joins Linux words with +", () => {
    const { container } = render(<KbdKeySequence keys={["Ctrl", "Shift", "C"]} isMac={false} />);
    expect(container.textContent).toBe("Ctrl+Shift+C");
  });
});
