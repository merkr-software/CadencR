// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { lspModHoverExtension, __setHoverForTest } from "./mod-hover";

function createView(doc: string): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: lspModHoverExtension() }),
  });
}

describe("lspModHoverExtension", () => {
  it("paints no underline before any hover", () => {
    const view = createView("foo bar baz");
    expect(view.dom.querySelectorAll(".cm-lsp-mod-hover").length).toBe(0);
    view.destroy();
  });

  it("paints an underline for the requested range", () => {
    const view = createView("foo bar baz");
    __setHoverForTest(view, { from: 0, to: 3 });
    const marks = view.dom.querySelectorAll(".cm-lsp-mod-hover");
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe("foo");
    view.destroy();
  });

  it("replaces the previous range when a new one is set", () => {
    const view = createView("foo bar baz");
    __setHoverForTest(view, { from: 0, to: 3 });
    __setHoverForTest(view, { from: 4, to: 7 });
    const marks = view.dom.querySelectorAll(".cm-lsp-mod-hover");
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe("bar");
    view.destroy();
  });

  it("clears the underline when set to null", () => {
    const view = createView("foo bar baz");
    __setHoverForTest(view, { from: 0, to: 3 });
    expect(view.dom.querySelectorAll(".cm-lsp-mod-hover").length).toBe(1);
    __setHoverForTest(view, null);
    expect(view.dom.querySelectorAll(".cm-lsp-mod-hover").length).toBe(0);
    view.destroy();
  });

  it("clears on Meta keyup so releasing CMD drops the underline", () => {
    const view = createView("foo bar baz");
    __setHoverForTest(view, { from: 0, to: 3 });
    expect(view.dom.querySelectorAll(".cm-lsp-mod-hover").length).toBe(1);
    view.contentDOM.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));
    expect(view.dom.querySelectorAll(".cm-lsp-mod-hover").length).toBe(0);
    view.destroy();
  });

  it("clears on blur so a tab-switch with CMD held doesn't strand the underline", () => {
    const view = createView("foo bar baz");
    __setHoverForTest(view, { from: 0, to: 3 });
    view.contentDOM.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    expect(view.dom.querySelectorAll(".cm-lsp-mod-hover").length).toBe(0);
    view.destroy();
  });
});
