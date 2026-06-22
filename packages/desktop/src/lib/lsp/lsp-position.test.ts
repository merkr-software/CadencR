import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

let pluginUri = "file:///workspace/src/a.ts";
let displayFileResult: EditorView | null = null;
const displayFile = vi.fn(async (_uri: string) => displayFileResult);

vi.mock("@codemirror/lsp-client", () => ({
  LSPPlugin: {
    get: () => ({
      uri: pluginUri,
      client: { workspace: { displayFile } },
    }),
  },
}));

import {
  lspPositionToOffset,
  lspRangeToOffsets,
  openLspLocation,
  symbolKindLabel,
} from "./lsp-position";

const TEXT = "abc\ndefgh\nij";

function doc(text: string) {
  return EditorState.create({ doc: text }).doc;
}

function view(text: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc: text }) });
}

describe("lspPositionToOffset", () => {
  it("maps line/character to a flat offset", () => {
    expect(lspPositionToOffset(doc(TEXT), { line: 0, character: 0 })).toBe(0);
    expect(lspPositionToOffset(doc(TEXT), { line: 1, character: 2 })).toBe(6);
    expect(lspPositionToOffset(doc(TEXT), { line: 2, character: 1 })).toBe(11);
  });

  it("clamps positions past the end of a line / document", () => {
    expect(lspPositionToOffset(doc(TEXT), { line: 0, character: 99 })).toBe(3);
    expect(lspPositionToOffset(doc(TEXT), { line: 99, character: 0 })).toBe(10);
  });
});

describe("lspRangeToOffsets", () => {
  it("returns from/to offsets", () => {
    const r = lspRangeToOffsets(doc(TEXT), {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 3 },
    });
    expect(r).toEqual({ from: 4, to: 7 });
  });
});

describe("openLspLocation", () => {
  it("jumps within the same file using the current view", async () => {
    pluginUri = "file:///workspace/src/a.ts";
    displayFile.mockClear();
    const v = view(TEXT);
    const target = await openLspLocation(v, {
      uri: "file:///workspace/src/a.ts",
      range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } },
    });
    expect(target).toBe(v);
    expect(displayFile).not.toHaveBeenCalled();
    expect(v.state.selection.main.head).toBe(5);
    v.destroy();
  });

  it("opens cross-file locations via the workspace displayFile bridge", async () => {
    pluginUri = "file:///workspace/src/a.ts";
    const other = view("xxxxx\nyyyyy");
    displayFileResult = other;
    displayFile.mockClear();
    const v = view(TEXT);
    const target = await openLspLocation(v, {
      uri: "file:///workspace/src/b.ts",
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } },
    });
    expect(displayFile).toHaveBeenCalledWith("file:///workspace/src/b.ts");
    expect(target).toBe(other);
    expect(other.state.selection.main.head).toBe(8);
    v.destroy();
    other.destroy();
  });

  it("returns null when the file cannot be displayed", async () => {
    pluginUri = "file:///workspace/src/a.ts";
    displayFileResult = null;
    const v = view(TEXT);
    const target = await openLspLocation(v, {
      uri: "file:///workspace/src/missing.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    });
    expect(target).toBeNull();
    v.destroy();
  });
});

describe("symbolKindLabel", () => {
  it("labels known kinds and empty-strings unknown ones", () => {
    expect(symbolKindLabel(12)).toBe("function");
    expect(symbolKindLabel(5)).toBe("class");
    expect(symbolKindLabel(999)).toBe("");
  });
});
