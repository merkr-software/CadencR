import { useEffect, useRef } from "react";

import { isEditableShortcutElement } from "@/lib/shortcuts/dom-targets";
import type { TabKind } from "@/stores/feature-layout-schema";

/**
 * Keeps keyboard focus (and the caret) inside a tab's content when a layout
 * change moves that content to another pane.
 *
 * Splitting a pane re-parents its host `<div>`: React removes the old host —
 * with the tab mount, and whatever was focused inside it, still attached —
 * before `TabContentRegistry` re-attaches the mount under the new host. The
 * browser drops focus to `<body>` on removal, so a split opened while the user
 * types in the agent prompt (auto layout does this on the agent's behalf)
 * would silently swallow their next keystrokes.
 *
 * We track the last text-entry element focused inside any tab mount (prompt,
 * terminal, editor buffer), plus the caret, and after a move restore both —
 * but only when focus fell to `<body>`, never when the user deliberately moved
 * it elsewhere. Links and buttons aren't tracked: clicking a link that opens
 * the Browser should leave focus with the Browser, not bounce it back.
 */

interface FocusMemory {
  element: HTMLElement;
  /** Caret for contenteditable content; inputs keep their own selection. */
  caret: { anchor: Node; anchorOffset: number; focus: Node; focusOffset: number } | null;
}

export function useTabFocusMemory(
  mounts: Record<TabKind, HTMLDivElement>,
): React.RefObject<FocusMemory | null> {
  const memory = useRef<FocusMemory | null>(null);

  useEffect((): (() => void) => {
    const insideMount = (node: Node): boolean =>
      Object.values(mounts).some((mount) => mount.contains(node));

    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      memory.current =
        target instanceof HTMLElement && isEditableShortcutElement(target) && insideMount(target)
          ? { element: target, caret: null }
          : null;
    };
    const onSelectionChange = (): void => {
      const current = memory.current;
      const selection = document.getSelection();
      if (!current?.element.isContentEditable || !selection?.anchorNode || !selection.focusNode) {
        return;
      }
      // Once detached, the selection collapses to <body>; keep the last caret
      // that was really inside the element.
      if (!current.element.contains(selection.anchorNode)) return;
      current.caret = {
        anchor: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focus: selection.focusNode,
        focusOffset: selection.focusOffset,
      };
    };

    // Clicking blank space also drops focus to <body>: that is the user
    // letting go, so forget the element. A layout move drops it too, but by
    // the time this microtask runs the registry has re-attached and refocused
    // it (or parked it hidden until its new pane mounts).
    const onFocusOut = (event: FocusEvent): void => {
      const element = memory.current?.element;
      if (!element || event.target !== element) return;
      queueMicrotask(() => {
        if (memory.current?.element !== element) return;
        if (!element.isConnected || document.activeElement === element) return;
        if (isParkedHidden(element)) return;
        memory.current = null;
      });
    };

    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return (): void => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [mounts]);

  return memory;
}

function isParkedHidden(element: HTMLElement): boolean {
  return element.closest<HTMLElement>("[data-tab-mount]")?.style.display === "none";
}

/** Call after moving tab mounts: refocus what the move knocked focus off. */
export function restoreTabFocus(memory: FocusMemory | null): void {
  if (!memory?.element.isConnected) return;
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  if (isParkedHidden(memory.element)) return;

  memory.element.focus({ preventScroll: true });
  const { caret } = memory;
  if (caret && memory.element.contains(caret.anchor) && memory.element.contains(caret.focus)) {
    document
      .getSelection()
      ?.setBaseAndExtent(caret.anchor, caret.anchorOffset, caret.focus, caret.focusOffset);
  }
}
