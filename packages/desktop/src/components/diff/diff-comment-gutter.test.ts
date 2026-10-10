// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commentGutter } from "./diff-comment-gutter";

function createView(doc: string, onClick: (n: number) => void): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: commentGutter(onClick),
    }),
  });
}

describe("commentGutter", () => {
  it("returns an array of extensions", () => {
    const extensions = commentGutter(vi.fn());
    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions.length).toBeGreaterThan(0);
  });

  it("creates an editor with the gutter without errors", () => {
    const view = createView("line 1\nline 2\nline 3", vi.fn());
    expect(view.state.doc.lines).toBe(3);
    const gutterEl = view.dom.querySelector(".cm-add-comment-gutter");
    expect(gutterEl).not.toBeNull();
    view.destroy();
  });

  it("does not show any marker by default", () => {
    const view = createView("line 1\nline 2", vi.fn());
    const markers = view.dom.querySelectorAll(".cm-add-comment-marker");
    expect(markers.length).toBe(0);
    view.destroy();
  });
});
