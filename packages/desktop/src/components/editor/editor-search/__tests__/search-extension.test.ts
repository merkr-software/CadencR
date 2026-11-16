// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  MAX_BUFFER_MATCHES,
  bufferSearchExtension,
  bufferSearchField,
  closeBufferSearch,
  findNextMatch,
  findPrevMatch,
  selectActiveMatch,
  setBufferActiveIndexEffect,
  setBufferSearchQuery,
  subscribeBufferSearch,
} from "../search-extension";

const createdViews: EditorView[] = [];

function makeView(doc: string, selection?: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: selection !== undefined ? { anchor: selection } : undefined,
    extensions: [bufferSearchExtension()],
  });
  const view = new EditorView({ state });
  createdViews.push(view);
  return view;
}

afterEach(() => {
  while (createdViews.length) {
    createdViews.pop()?.destroy();
  }
});

describe("bufferSearchField", () => {
  it("starts empty", () => {
    const view = makeView("hello world");
    const s = view.state.field(bufferSearchField);
    expect(s.matches).toEqual([]);
    expect(s.activeIndex).toBe(-1);
    expect(s.error).toBeNull();
  });

  it("finds literal matches case-insensitively by default", () => {
    const view = makeView("Foo foo FOO bar");
    setBufferSearchQuery(view, { query: "foo", caseSensitive: false, regex: false });
    const s = view.state.field(bufferSearchField);
    expect(s.matches.length).toBe(3);
    expect(s.activeIndex).toBe(0);
  });

  it("respects case-sensitive mode", () => {
    const view = makeView("Foo foo FOO");
    setBufferSearchQuery(view, { query: "foo", caseSensitive: true, regex: false });
    const s = view.state.field(bufferSearchField);
    expect(s.matches.length).toBe(1);
    expect(s.matches[0]).toEqual({ from: 4, to: 7 });
  });

  it("supports regex search", () => {
    const view = makeView("foo123 bar456 baz");
    setBufferSearchQuery(view, { query: "\\d+", caseSensitive: false, regex: true });
    const s = view.state.field(bufferSearchField);
    expect(s.matches.length).toBe(2);
    expect(s.matches[0].to - s.matches[0].from).toBe(3);
  });

  it("reports an error for invalid regex without throwing", () => {
    const view = makeView("hello");
    setBufferSearchQuery(view, { query: "[unterminated", caseSensitive: false, regex: true });
    const s = view.state.field(bufferSearchField);
    expect(s.error).not.toBeNull();
    expect(s.matches).toEqual([]);
  });

  it("caps matches at MAX_BUFFER_MATCHES and reports truncation", () => {
    const view = makeView("a".repeat(MAX_BUFFER_MATCHES + 50));
    setBufferSearchQuery(view, { query: "a", caseSensitive: false, regex: false });
    const s = view.state.field(bufferSearchField);
    expect(s.matches.length).toBe(MAX_BUFFER_MATCHES);
    expect(s.truncated).toBe(true);
  });

  it("clears truncation and error flags when a valid narrower query replaces a broken one", () => {
    const view = makeView("foo bar");
    setBufferSearchQuery(view, { query: "[bad", caseSensitive: false, regex: true });
    expect(view.state.field(bufferSearchField).error).not.toBeNull();
    setBufferSearchQuery(view, { query: "bar", caseSensitive: false, regex: false });
    const s = view.state.field(bufferSearchField);
    expect(s.error).toBeNull();
    expect(s.truncated).toBe(false);
    expect(s.matches.length).toBe(1);
  });

  it("findNextMatch wraps around at the end", () => {
    const view = makeView("a b a b a");
    setBufferSearchQuery(view, { query: "a", caseSensitive: false, regex: false });
    expect(view.state.field(bufferSearchField).activeIndex).toBe(0);
    findNextMatch(view);
    expect(view.state.field(bufferSearchField).activeIndex).toBe(1);
    findNextMatch(view);
    expect(view.state.field(bufferSearchField).activeIndex).toBe(2);
    findNextMatch(view);
    expect(view.state.field(bufferSearchField).activeIndex).toBe(0);
  });

  it("findPrevMatch wraps around at the start", () => {
    const view = makeView("a b a b a");
    setBufferSearchQuery(view, { query: "a", caseSensitive: false, regex: false });
    findPrevMatch(view);
    expect(view.state.field(bufferSearchField).activeIndex).toBe(2);
    findPrevMatch(view);
    expect(view.state.field(bufferSearchField).activeIndex).toBe(1);
  });

  it("closeBufferSearch clears state and matches", () => {
    const view = makeView("foo foo");
    setBufferSearchQuery(view, { query: "foo", caseSensitive: false, regex: false });
    expect(view.state.field(bufferSearchField).matches.length).toBe(2);
    closeBufferSearch(view);
    const s = view.state.field(bufferSearchField);
    expect(s.matches).toEqual([]);
    expect(s.activeIndex).toBe(-1);
    expect(s.query.query).toBe("");
  });

  it("setBufferActiveIndexEffect wraps any out-of-range integer modularly", () => {
    const view = makeView("a a a");
    setBufferSearchQuery(view, { query: "a", caseSensitive: false, regex: false });
    view.dispatch({ effects: setBufferActiveIndexEffect.of(-5) });
    expect(view.state.field(bufferSearchField).activeIndex).toBe(1);
    view.dispatch({ effects: setBufferActiveIndexEffect.of(7) });
    expect(view.state.field(bufferSearchField).activeIndex).toBe(1);
  });

  describe("initial active match selection (pickInitialActive)", () => {
    it("picks the first match at or after the cursor", () => {
      const view = makeView("a b a b a", 4);
      setBufferSearchQuery(view, { query: "a", caseSensitive: false, regex: false });
      // Matches at 0, 4, 8; cursor at 4 → active index 1.
      expect(view.state.field(bufferSearchField).activeIndex).toBe(1);
    });

    it("wraps to the first match when the cursor sits past the last match", () => {
      const view = makeView("a b a b a", 9);
      setBufferSearchQuery(view, { query: "a", caseSensitive: false, regex: false });
      expect(view.state.field(bufferSearchField).activeIndex).toBe(0);
    });

    it("uses the first match when the cursor is before every match", () => {
      const view = makeView("xx a b a", 0);
      setBufferSearchQuery(view, { query: "a", caseSensitive: false, regex: false });
      expect(view.state.field(bufferSearchField).activeIndex).toBe(0);
    });

    it("selects the match containing the cursor instead of the next one", () => {
      // doc "foobar more foobar"; matches at [0,6] and [12,18]. Cursor at 3
      // sits INSIDE the first match — selecting the second would surprise
      // the user. The first match should win.
      const view = makeView("foobar more foobar", 3);
      setBufferSearchQuery(view, { query: "foobar", caseSensitive: false, regex: false });
      expect(view.state.field(bufferSearchField).activeIndex).toBe(0);
    });
  });

  describe("document edits while search is open", () => {
    it("re-scans matches when the document changes", () => {
      const view = makeView("foo bar foo");
      setBufferSearchQuery(view, { query: "foo", caseSensitive: false, regex: false });
      expect(view.state.field(bufferSearchField).matches.length).toBe(2);
      view.dispatch({ changes: { from: 11, insert: " foo" } });
      expect(view.state.field(bufferSearchField).matches.length).toBe(3);
    });

    it("keeps the active match aligned with its mapped position after an insertion before it", () => {
      const view = makeView("foo foo foo");
      setBufferSearchQuery(view, { query: "foo", caseSensitive: false, regex: false });
      findNextMatch(view); // activate match #2 at pos 4
      expect(view.state.field(bufferSearchField).activeIndex).toBe(1);
      // Insert 4 chars at the very start of the document.
      view.dispatch({ changes: { from: 0, insert: "AAA " } });
      // The 2nd "foo" used to be at 4, now at 8. After re-scan, active should
      // still target the same logical match (now index 1 again).
      const s = view.state.field(bufferSearchField);
      expect(s.matches[s.activeIndex].from).toBe(8);
    });

    it("drops the active match when its underlying text is deleted but other matches survive", () => {
      const view = makeView("foo bar foo");
      setBufferSearchQuery(view, { query: "foo", caseSensitive: false, regex: false });
      findNextMatch(view); // active = match at pos 8
      // Delete the trailing "foo".
      view.dispatch({ changes: { from: 7, to: 11, insert: "" } });
      const s = view.state.field(bufferSearchField);
      expect(s.matches.length).toBe(1);
      expect(s.activeIndex).toBeGreaterThanOrEqual(0);
      expect(s.activeIndex).toBeLessThan(s.matches.length);
    });

    it("does not run a re-scan when the query is empty", () => {
      const view = makeView("nothing here");
      // No query set — doc change should keep matches empty without throwing.
      view.dispatch({ changes: { from: 0, insert: "x" } });
      expect(view.state.field(bufferSearchField).matches).toEqual([]);
    });
  });

  describe("selectActiveMatch", () => {
    it("moves the editor selection onto the active match", () => {
      const view = makeView("foo bar foo");
      setBufferSearchQuery(view, { query: "foo", caseSensitive: false, regex: false });
      findNextMatch(view);
      selectActiveMatch(view);
      const sel = view.state.selection.main;
      expect(sel.from).toBe(8);
      expect(sel.to).toBe(11);
    });

    it("is a no-op when there is no active match", () => {
      const view = makeView("hello");
      const before = view.state.selection.main;
      selectActiveMatch(view);
      const after = view.state.selection.main;
      expect(after.from).toBe(before.from);
      expect(after.to).toBe(before.to);
    });
  });

  describe("subscribeBufferSearch", () => {
    it("calls the subscriber with the new state when the field changes", () => {
      const view = makeView("foo foo");
      const cb = vi.fn();
      const unsubscribe = subscribeBufferSearch(view, cb);
      setBufferSearchQuery(view, { query: "foo", caseSensitive: false, regex: false });
      expect(cb).toHaveBeenCalled();
      const last = cb.mock.calls.at(-1)?.[0];
      expect(last?.matches.length).toBe(2);
      unsubscribe();
    });

    it("stops firing after unsubscribe", () => {
      const view = makeView("foo foo");
      const cb = vi.fn();
      const unsubscribe = subscribeBufferSearch(view, cb);
      unsubscribe();
      setBufferSearchQuery(view, { query: "foo", caseSensitive: false, regex: false });
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
