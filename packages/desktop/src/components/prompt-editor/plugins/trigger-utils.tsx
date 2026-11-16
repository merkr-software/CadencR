import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import {
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from "lexical";
import { composerOptionId } from "@/components/composer/ComposerPopover";
import { shallow } from "zustand/shallow";
import { composerPopoverPlacement } from "./composer-popover-placement";

/** Result of matching a trigger character (e.g. `@` or `/`) before the cursor. */
interface TriggerMatch {
  query: string;
  triggerOffset: number;
}

/**
 * Finds `<triggerChar>query` text before the cursor in the given text node.
 * The trigger must be at the start of text or preceded by whitespace.
 * Returns null if no valid trigger is found.
 */
export function getTriggerMatch(
  anchorNode: TextNode,
  anchorOffset: number,
  triggerChar: string,
): TriggerMatch | null {
  const text = anchorNode.getTextContent().slice(0, anchorOffset);
  const idx = text.lastIndexOf(triggerChar);
  if (idx === -1) return null;
  if (idx > 0 && !/\s/.test(text[idx - 1])) return null;

  const query = text.slice(idx + triggerChar.length);
  if (query.includes(" ")) return null;

  return { query, triggerOffset: idx };
}

/**
 * Replaces the trigger text (e.g. `@query` or `/query`) in the current selection
 * with a new Lexical node. Moves the cursor after the inserted node.
 */
export function replaceTriggerWithNode(
  editor: LexicalEditor,
  triggerChar: string,
  createNode: (value: string) => LexicalNode,
  value: string,
  onDone: () => void,
): void {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

    const anchor = selection.anchor;
    const node = anchor.getNode();
    if (!$isTextNode(node)) return;

    const match = getTriggerMatch(node, anchor.offset, triggerChar);
    if (!match) return;

    const triggerEnd = match.triggerOffset + triggerChar.length + match.query.length;
    const newNode = createNode(value);

    const splitPoints = [match.triggerOffset, triggerEnd].filter(
      (p) => p > 0 && p < node.getTextContentSize(),
    );
    const parts = node.splitText(...splitPoints);

    let targetIndex = 0;
    let offset = 0;
    for (let i = 0; i < parts.length; i++) {
      const len = parts[i].getTextContentSize();
      if (offset <= match.triggerOffset && match.triggerOffset < offset + len) {
        targetIndex = i;
        break;
      }
      offset += len;
    }

    parts[targetIndex].replace(newNode);
    // Insert a trailing space so the cursor has a proper text position
    // after the token node (which has canInsertTextAfter() = false).
    const spaceNode = $createTextNode(" ");
    newNode.insertAfter(spaceNode);
    spaceNode.select();
  });

  onDone();
}

/** Hook state expected from the underlying trigger hook (useFileMention / useSlashCommand). */
interface TriggerHookState {
  isOpen: boolean;
  close: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, text: string) => void;
  filteredItems: readonly unknown[];
  selectedIndex: number;
}

/**
 * Registers the 5 keyboard commands (ArrowUp, ArrowDown, Enter, Tab, Escape)
 * on the editor while the popover is open, and — when `listId` is given —
 * points the editor root's combobox ARIA at the popover's listbox so screen
 * readers announce the highlighted option.
 */
export function usePopoverKeyboardCommands<T>(
  editor: LexicalEditor,
  isOpen: boolean,
  hookRef: RefObject<TriggerHookState>,
  getSelectedValue: () => T | undefined,
  onSelect: (value: T) => void,
  listId?: string,
): void {
  useComboboxAria(editor, isOpen, listId, hookRef.current?.selectedIndex ?? 0);
  useEffect(() => {
    if (!isOpen) return;

    const fakeEvent = (key: string) =>
      ({
        key,
        preventDefault: () => {},
        shiftKey: false,
        metaKey: false,
        altKey: false,
      }) as React.KeyboardEvent<HTMLTextAreaElement>;

    const commands = [
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (e) => {
          e?.preventDefault();
          hookRef.current.handleKeyDown(fakeEvent("ArrowDown"), "");
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (e) => {
          e?.preventDefault();
          hookRef.current.handleKeyDown(fakeEvent("ArrowUp"), "");
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (e) => {
          const val = getSelectedValue();
          if (val === undefined) return false;
          e?.preventDefault();
          onSelect(val);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (e) => {
          const val = getSelectedValue();
          if (val === undefined) return false;
          e?.preventDefault();
          onSelect(val);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (e) => {
          // The popover owns this Esc: nothing above the editor (agent stop,
          // pane close) may also react to it.
          e?.preventDefault();
          e?.stopPropagation();
          hookRef.current.close();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];

    return () => commands.forEach((unregister) => unregister());
  }, [editor, isOpen, hookRef, getSelectedValue, onSelect]);
}

/** Mirror an open typeahead onto the editor root's combobox attributes. */
function useComboboxAria(
  editor: LexicalEditor,
  isOpen: boolean,
  listId: string | undefined,
  selectedIndex: number,
): void {
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root || !listId) return;
    if (!isOpen) {
      root.setAttribute("aria-expanded", "false");
      root.removeAttribute("aria-activedescendant");
      return;
    }
    root.setAttribute("aria-expanded", "true");
    root.setAttribute("aria-controls", listId);
    root.setAttribute("aria-activedescendant", composerOptionId(listId, selectedIndex));
  }, [editor, isOpen, listId, selectedIndex]);
}

/** Where a typeahead popover sits: at the composer card's width, rising from `bottom`. */
export interface ComposerPopoverAnchor {
  left: number;
  width: number;
  bottom: number;
  maxHeight: number;
}

/** Positions a typeahead popover at its anchor (see `useComposerPopoverAnchor`). */
export function AnchoredPopover({
  anchor,
  children,
}: {
  anchor: ComposerPopoverAnchor;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed z-50"
      style={{
        left: anchor.left,
        top: anchor.bottom,
        width: anchor.width,
        transform: "translateY(-100%)",
      }}
    >
      {children}
    </div>
  );
}

/** Top of the caret's line when the selection sits in `root`. */
function caretLineTop(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const node = selection.anchorNode;
  if (!node || !root.contains(node)) return null;
  const lineRect = selection.getRangeAt(0).getClientRects()[0];
  if (lineRect) return lineRect.top;
  // A caret in an empty paragraph has no client rect: use the paragraph's.
  const element = node instanceof Element ? node : node.parentElement;
  return element ? element.getBoundingClientRect().top : null;
}

/**
 * Tracks where a typeahead popover goes while `active`, so fixed popovers can
 * escape composer overflow yet stay prompt-width. Uses ResizeObserver +
 * scroll/resize (rAF-coalesced, equality-gated) — not Lexical updates. Also
 * follows the caret's line and the visual viewport: on a phone, the keyboard
 * moves the card without resizing it, and a tall draft leaves no room above it
 * (see `composerPopoverPlacement`).
 */
export function useComposerPopoverAnchor(
  editor: LexicalEditor,
  active: boolean,
): ComposerPopoverAnchor | null {
  const [rect, setRect] = useState<ComposerPopoverAnchor | null>(null);

  useLayoutEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }

    const root = editor.getRootElement();
    const anchor =
      (root?.closest("[data-composer-card]") as HTMLElement | null) ??
      (root?.closest("[data-prompt-editor-anchor]") as HTMLElement | null) ??
      root?.parentElement ??
      root;
    if (!root || !anchor) return;

    let frame: number | null = null;
    let last: ComposerPopoverAnchor | null = null;
    const vv = window.visualViewport;

    const sync = (): void => {
      frame = null;
      const card = anchor.getBoundingClientRect();
      const viewportTop = vv?.offsetTop ?? 0;
      const next = {
        left: card.left,
        width: card.width,
        ...composerPopoverPlacement({
          cardTop: card.top,
          caretTop: caretLineTop(root),
          viewportTop,
          viewportBottom: vv ? viewportTop + vv.height : window.innerHeight,
        }),
      };
      if (shallow(last, next)) return;
      last = next;
      setRect(next);
    };
    const schedule = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(sync);
    };

    sync();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(anchor);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    document.addEventListener("selectionchange", schedule);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      document.removeEventListener("selectionchange", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [active, editor]);

  return rect;
}
