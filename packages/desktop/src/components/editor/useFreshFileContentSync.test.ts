// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useFreshFileContentSync } from "./useFreshFileContentSync";

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
});

function setup(content = "original") {
  const onDirtyChange = vi.fn();
  const view = new EditorView({ state: EditorState.create({ doc: content }) });
  views.push(view);
  const viewRef = { current: view };
  const hook = renderHook(
    ({ content }) => useFreshFileContentSync({ content, viewRef, onDirtyChange }),
    { initialProps: { content } },
  );
  const edit = (insert: string) =>
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } });
      hook.result.current.onDocChange(view.state.doc);
    });
  return { ...hook, view, viewRef, edit, onDirtyChange };
}

describe("client-owned file buffer", () => {
  it("follows disk only while clean, preserving local edits across repeated disk changes", () => {
    const h = setup();
    h.rerender({ content: "external 1" });
    expect(h.view.state.doc.toString()).toBe("external 1");
    expect(h.onDirtyChange).not.toHaveBeenCalled();
    h.edit("my edits");
    h.rerender({ content: "external 2" });
    h.rerender({ content: "external 3" });
    expect(h.view.state.doc.toString()).toBe("my edits");
    expect(h.result.current.diskChanged).toBe(true);
  });

  it("does not flag ordinary typing or unchanged watcher reads as a disk conflict", () => {
    const h = setup();
    h.edit("local");
    h.rerender({ content: "original" });
    expect(h.result.current.diskChanged).toBe(false);
    expect(h.result.current.dirtyRef.current).toBe(true);
  });

  it("clears the conflict when disk returns to the baseline", () => {
    const h = setup();
    h.edit("local");
    h.rerender({ content: "external" });
    h.rerender({ content: "original" });
    expect(h.result.current.diskChanged).toBe(false);
    expect(h.view.state.doc.toString()).toBe("local");
  });

  it("clears dirty and conflict when the user makes the buffer equal disk", () => {
    const h = setup();
    h.edit("local");
    h.rerender({ content: "external" });
    h.edit("external");
    expect(h.result.current.diskChanged).toBe(false);
    expect(h.onDirtyChange).toHaveBeenLastCalledWith(false);
    h.rerender({ content: "next external" });
    expect(h.view.state.doc.toString()).toBe("next external");
  });

  it("keeps newer edits dirty when an older save completes", () => {
    const h = setup();
    h.edit("snapshot saved");
    const snapshot = h.view.state.doc;
    h.edit("newer typing");
    act(() => h.result.current.markSaved(snapshot));
    h.rerender({ content: "snapshot saved" });
    expect(h.view.state.doc.toString()).toBe("newer typing");
    expect(h.result.current.dirtyRef.current).toBe(true);
    expect(h.result.current.diskChanged).toBe(false);
  });

  it("adopts disk as the new baseline once it equals local edits", () => {
    const h = setup();
    h.edit("mine");
    h.rerender({ content: "mine" });
    h.edit("next local edit");
    expect(h.result.current.diskChanged).toBe(false);
    expect(h.result.current.dirtyRef.current).toBe(true);
  });

  it("explicit reload replaces unsaved content and clears conflict", () => {
    const h = setup();
    h.edit("local");
    h.rerender({ content: "external" });
    act(() => h.result.current.reload("latest external"));
    expect(h.view.state.doc.toString()).toBe("latest external");
    expect(h.result.current.diskChanged).toBe(false);
    expect(h.onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("normalizes CRLF disk snapshots like CodeMirror", () => {
    const h = setup("one\r\ntwo\r\n");
    expect(h.result.current.dirtyRef.current).toBe(false);
    h.rerender({ content: "one\r\nchanged\r\n" });
    expect(h.view.state.doc.toString()).toBe("one\nchanged\n");
    expect(h.result.current.diskChanged).toBe(false);
  });

  it("uses immutable document comparisons without serializing large buffers on typing", () => {
    const h = setup("const longFile = true;\n".repeat(100_000));
    const stringify = vi.spyOn(h.view.state.doc, "toString");
    act(() => h.result.current.onDocChange(h.view.state.doc));
    expect(stringify).not.toHaveBeenCalled();
    h.edit("local prefix\n" + "const longFile = true;\n".repeat(100_000));
    h.rerender({ content: "external version" });
    expect(h.view.state.doc.length).toBe(2_300_013);
    expect(h.result.current.diskChanged).toBe(true);
  });
  it("compares same-length tail edits against the shared live document tree", () => {
    const h = setup("large line\n".repeat(100_000));
    const baseline = h.view.state.doc;
    const transaction = h.view.state.update({
      changes: { from: baseline.length - 2, to: baseline.length - 1, insert: "X" },
    });
    const equals = vi.spyOn(transaction.state.doc, "eq");
    act(() => {
      h.view.dispatch(transaction);
      h.result.current.onDocChange(transaction.state.doc);
    });
    expect(equals.mock.calls[0]?.[0]).toBe(baseline);
    expect(h.result.current.dirtyRef.current).toBe(true);
  });
  it("adopts a lazily mounted view as the shared clean baseline", () => {
    const viewRef: { current: EditorView | null } = { current: null };
    const { result } = renderHook(() =>
      useFreshFileContentSync({
        content: "loaded before lazy editor",
        viewRef,
        onDirtyChange: vi.fn(),
      }),
    );
    const view = new EditorView({
      state: EditorState.create({ doc: "loaded before lazy editor" }),
    });
    views.push(view);
    viewRef.current = view;
    const baseline = view.state.doc;
    act(() => {
      result.current.onDocChange(baseline);
    });
    const transaction = view.state.update({ changes: { from: 0, to: 1, insert: "L" } });
    const equals = vi.spyOn(transaction.state.doc, "eq");
    act(() => {
      view.dispatch(transaction);
      result.current.onDocChange(view.state.doc);
    });
    expect(equals.mock.calls[0]?.[0]).toBe(baseline);
  });
});
