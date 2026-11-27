import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { scrollToEditorLine } from "./editor-lines";

describe("one-based editor positions", () => {
  it.each([
    [2, 3, 8],
    [2, 99, 10],
    [99, 2, 12],
    [-1, -1, 0],
  ])("clamps line %s and column %s to the available text", (line, column, expected) => {
    const state = EditorState.create({ doc: "first\nnext\nlast" });
    const dispatch = vi.fn();
    scrollToEditorLine({ state, dispatch } as unknown as EditorView, line, column);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { anchor: expected } }),
    );
  });
});
