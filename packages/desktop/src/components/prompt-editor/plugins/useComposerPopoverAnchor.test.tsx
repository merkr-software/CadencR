import { act, renderHook } from "@testing-library/react";
import type { LexicalEditor } from "lexical";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerPopoverAnchor } from "./trigger-utils";

/** A composer card holding the editor root, with a scripted box and caret. */
function mountComposer(cardTop: number) {
  const card = document.createElement("div");
  card.setAttribute("data-composer-card", "");
  const root = document.createElement("div");
  const paragraph = document.createElement("p");
  paragraph.textContent = "draft";
  root.append(paragraph);
  card.append(root);
  document.body.append(card);

  const box = { top: cardTop };
  vi.spyOn(card, "getBoundingClientRect").mockImplementation(
    () => ({ left: 12, top: box.top, width: 378 }) as DOMRect,
  );
  const caret = { top: 700 as number | null, node: paragraph.firstChild as Node };
  vi.spyOn(window, "getSelection").mockImplementation(
    () =>
      ({
        rangeCount: 1,
        anchorNode: caret.node,
        getRangeAt: () => ({
          getClientRects: () => (caret.top === null ? [] : [{ top: caret.top }]),
        }),
      }) as unknown as Selection,
  );

  const editor = { getRootElement: () => root } as unknown as LexicalEditor;
  return { card, editor, box, caret };
}

describe("useComposerPopoverAnchor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(874);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("stays null while inactive", () => {
    const { editor } = mountComposer(600);
    const { result } = renderHook(() => useComposerPopoverAnchor(editor, false));
    expect(result.current).toBeNull();
  });

  it("rises from the card's top at its width", () => {
    const { editor } = mountComposer(600);
    const { result } = renderHook(() => useComposerPopoverAnchor(editor, true));
    expect(result.current).toEqual({ left: 12, width: 378, bottom: 596, maxHeight: 300 });
  });

  it("follows the caret's line once the room above the card runs short", () => {
    const { editor, caret } = mountComposer(129);
    const { result } = renderHook(() => useComposerPopoverAnchor(editor, true));
    expect(result.current?.bottom).toBe(696);

    caret.top = 250;
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersToNextFrame();
    });
    expect(result.current).toMatchObject({ bottom: 246, maxHeight: 238 });
  });

  it("keeps its identity when a selection change moves nothing", () => {
    const { editor } = mountComposer(600);
    const { result } = renderHook(() => useComposerPopoverAnchor(editor, true));
    const first = result.current;

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersToNextFrame();
    });
    expect(result.current).toBe(first);
  });

  it("falls back to the paragraph's box for a caret in an empty paragraph", () => {
    const { editor, card, caret } = mountComposer(129);
    const paragraph = card.querySelector("p")!;
    vi.spyOn(paragraph, "getBoundingClientRect").mockReturnValue({ top: 300 } as DOMRect);
    caret.top = null;
    caret.node = paragraph;

    const { result } = renderHook(() => useComposerPopoverAnchor(editor, true));
    expect(result.current?.bottom).toBe(296);
  });

  it("stays above the card when the selection is outside the editor", () => {
    const { editor, caret } = mountComposer(129);
    caret.node = document.body;

    const { result } = renderHook(() => useComposerPopoverAnchor(editor, true));
    expect(result.current).toMatchObject({ bottom: 125, maxHeight: 117 });
  });

  it("stops tracking once closed", () => {
    const { editor, box } = mountComposer(600);
    const { result, rerender } = renderHook(
      ({ active }) => useComposerPopoverAnchor(editor, active),
      { initialProps: { active: true } },
    );
    rerender({ active: false });
    expect(result.current).toBeNull();

    box.top = 400;
    act(() => {
      window.dispatchEvent(new Event("resize"));
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersToNextFrame();
    });
    expect(result.current).toBeNull();
  });
});
