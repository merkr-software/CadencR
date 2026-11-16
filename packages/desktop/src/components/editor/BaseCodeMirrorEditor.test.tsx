// @vitest-environment jsdom
// CodeMirror needs queued selectionchange events; happy-dom dispatches them synchronously.
import { createRef } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import BaseCodeMirrorEditor from "./BaseCodeMirrorEditor";

describe("uncontrolled CodeMirror document", () => {
  it("does not serialize the full large buffer for document-only change notifications", () => {
    const editorViewRef = createRef<EditorView>();
    const onDocChange = vi.fn();
    render(
      <BaseCodeMirrorEditor
        initialContent={"large file line\n".repeat(100_000)}
        ergonomics={false}
        editorViewRef={editorViewRef}
        onDocChange={onDocChange}
      />,
    );
    const view = editorViewRef.current!;
    const transaction = view.state.update({ changes: { from: 0, insert: "my  spacing  " } });
    const stringify = vi.spyOn(transaction.state.doc, "toString");
    act(() => view.dispatch(transaction));
    expect(onDocChange).toHaveBeenCalledWith(transaction.state.doc);
    expect(stringify).not.toHaveBeenCalled();
    expect(view.state.doc.sliceString(0, 13)).toBe("my  spacing  ");
  });

  it("ignores stale initialContent props and retains the live document and selection", () => {
    const editorViewRef = createRef<EditorView>();
    const { rerender } = render(
      <BaseCodeMirrorEditor initialContent="original" editorViewRef={editorViewRef} />,
    );
    const view = editorViewRef.current!;
    act(() => view.dispatch({ changes: { from: 0, insert: "new " }, selection: { anchor: 4 } }));
    const doc = view.state.doc;
    rerender(
      <BaseCodeMirrorEditor initialContent="stale server snapshot" editorViewRef={editorViewRef} />,
    );
    expect(editorViewRef.current).toBe(view);
    expect(view.state.doc).toBe(doc);
    expect(view.state.selection.main.head).toBe(4);
  });
});
