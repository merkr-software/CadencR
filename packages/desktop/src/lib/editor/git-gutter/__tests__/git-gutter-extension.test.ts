// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { gitGutterExtension, setGitGutterBaseline } from "../git-gutter-extension";

let view: EditorView | undefined;

function gutterKinds(doc: string, baseline: string): string[] {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: gitGutterExtension() }),
    parent: document.body,
  });
  view.dispatch({ effects: setGitGutterBaseline.of(baseline) });
  return [...view.dom.querySelectorAll(".cm-git-gutter-marker")].map((el) =>
    el.className.replace("cm-git-gutter-marker cm-git-gutter-", ""),
  );
}

afterEach(() => {
  view?.destroy();
  view = undefined;
});

describe("gitGutterExtension", () => {
  it("draws the deletion of a line", () => {
    expect(gutterKinds("a\nc\n", "a\nb\nc\n")).toEqual(["deleted"]);
  });

  it("reads a CRLF baseline the way the editor holds the file", () => {
    // The editor joins its lines with `\n`; HEAD content keeps `\r\n`.
    expect(gutterKinds("a\nb\n", "a\r\nb\r\n")).toEqual([]);
    view?.destroy();
    expect(gutterKinds("a\nb\nc\n", "a\r\nc\r\n")).toEqual(["added"]);
  });
});
