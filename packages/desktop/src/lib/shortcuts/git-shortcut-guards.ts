import {
  getDeepestActiveElement,
  hasActiveTextSelection,
  isEditableShortcutElement,
  isEditableShortcutTarget,
} from "./dom-targets";

const OPEN_OVERLAY_SELECTOR = [
  "[data-slot='dialog-content'][data-state='open']",
  "[data-slot='popover-content'][data-state='open']",
  "[data-slot='dropdown-menu-content'][data-state='open']",
  "[data-slot='dropdown-menu-sub-content'][data-state='open']",
  "[data-slot='context-menu-content'][data-state='open']",
  "[data-slot='context-menu-sub-content'][data-state='open']",
  "[data-slot='select-content'][data-state='open']",
  "[role='dialog'][data-state='open']",
  "[role='menu'][data-state='open']",
  "[role='listbox'][data-state='open']",
  "[role='dialog']:not([data-state]):not([aria-hidden='true'])",
  "[role='menu']:not([data-state]):not([aria-hidden='true'])",
  "[role='listbox']:not([data-state]):not([aria-hidden='true'])",
].join(",");

function composedPathOwnsTextInput(event: KeyboardEvent): boolean {
  return event.composedPath().some((target) => isEditableShortcutElement(target));
}

/**
 * An overlay left open in an inert subtree (a conversation workspace kept
 * mounted but hidden, a collapsed sidebar) owns no key: only reachable ones count.
 */
function hasOpenOverlay(): boolean {
  return Array.from(document.querySelectorAll(OPEN_OVERLAY_SELECTOR)).some(
    (overlay) => overlay.closest("[inert]") === null,
  );
}

/**
 * True when the keystroke carries a modifier that no amount of typing or
 * selecting could produce. Shift does not count: it extends a selection and
 * shifts a character, so a Shift-only combo is still competing with the text.
 */
function isChord(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

/** True when the active surface, composition session, or overlay owns the key. */
export function shouldIgnoreGitShortcut(event: KeyboardEvent): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.key === "Process" ||
    event.keyCode === 229
  ) {
    return true;
  }
  if (composedPathOwnsTextInput(event) || isEditableShortcutTarget(getDeepestActiveElement())) {
    return true;
  }
  if (hasOpenOverlay()) return true;
  // A live selection only speaks for the bare keys. Git's navigation map is
  // single letters, so `j` while a range is highlighted is far more likely to
  // be a mis-typed selection gesture than a request to move — but `⌘Y` never
  // is. The selection is also document-wide: highlighting a line to copy it
  // (or a sentence in the agent transcript three tabs ago) used to disable
  // every Git chord until something happened to collapse it, which is what
  // made the sub-view shortcuts read as simply not implemented.
  return !isChord(event) && hasActiveTextSelection();
}
