import { COMPOSER_POPOVER_MAX_HEIGHT } from "@/components/composer/ComposerPopover";

/** Below this the list shows too few rows to pick from (about four). */
const COMPOSER_POPOVER_MIN_HEIGHT = 160;
/** Between the popover and what it rises from. */
const ANCHOR_GAP_PX = 4;
/** Kept clear between the popover and the top of the visible viewport. */
const VIEWPORT_MARGIN_PX = 8;

/** Where the prompt is, in layout-viewport coordinates (what `position: fixed` uses). */
export interface PopoverAnchorMetrics {
  /** Top edge of the composer card. */
  cardTop: number;
  /** Top of the caret's line; null when the selection is outside the editor. */
  caretTop: number | null;
  /** Top of the visible viewport: iOS can pan it below the layout viewport's top. */
  viewportTop: number;
  /** Bottom of the visible viewport: on a phone, the top of the keyboard. */
  viewportBottom: number;
}

export interface ComposerPopoverPlacement {
  /** The popover's bottom edge, in the same coordinates as the metrics. */
  bottom: number;
  maxHeight: number;
}

/**
 * The popover rises from the composer card's top edge. When the room above it
 * is too short for a usable list (a phone with its keyboard open and a tall
 * draft), it rises from just above the caret's line instead, over the draft
 * above the caret: next to what is being typed, and never off the screen. It
 * is never taller than the room it has, and never covers the caret.
 */
export function composerPopoverPlacement(metrics: PopoverAnchorMetrics): ComposerPopoverPlacement {
  const ceiling = metrics.viewportTop + VIEWPORT_MARGIN_PX;
  let bottom = metrics.cardTop - ANCHOR_GAP_PX;
  if (bottom - ceiling < COMPOSER_POPOVER_MIN_HEIGHT && metrics.caretTop !== null) {
    // A caret scrolled out below the editor's visible part still reports its
    // line: keep the popover above the keyboard all the same.
    bottom = Math.min(
      Math.max(bottom, metrics.caretTop - ANCHOR_GAP_PX),
      metrics.viewportBottom - ANCHOR_GAP_PX,
    );
  }
  return {
    bottom,
    maxHeight: Math.max(0, Math.min(COMPOSER_POPOVER_MAX_HEIGHT, bottom - ceiling)),
  };
}
