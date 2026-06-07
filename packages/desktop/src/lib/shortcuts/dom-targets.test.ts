import { describe, expect, it } from "vitest";
import { isInCodeMirrorEditor, isInTerminalFocusZone } from "@/lib/shortcuts/dom-targets";

describe("shortcut DOM target predicates", () => {
  it("detects CodeMirror editor descendants", () => {
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const child = document.createElement("textarea");
    editor.appendChild(child);

    expect(isInCodeMirrorEditor(child)).toBe(true);
    expect(isInCodeMirrorEditor(editor)).toBe(true);
    expect(isInCodeMirrorEditor(null)).toBe(false);
    expect(isInCodeMirrorEditor(document.createElement("div"))).toBe(false);
  });

  it("detects terminal focus-zone descendants", () => {
    const terminal = document.createElement("div");
    terminal.dataset.focusZone = "terminal";
    const textarea = document.createElement("textarea");
    terminal.appendChild(textarea);

    expect(isInTerminalFocusZone(textarea)).toBe(true);
    expect(isInTerminalFocusZone(terminal)).toBe(true);
    expect(isInTerminalFocusZone(null)).toBe(false);
    expect(isInTerminalFocusZone(document.createElement("div"))).toBe(false);
  });
});
