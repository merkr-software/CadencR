import { describe, expect, it } from "vitest";
import { COMPOSER_POPOVER_MAX_HEIGHT } from "@/components/composer/ComposerPopover";
import { composerPopoverPlacement, type PopoverAnchorMetrics } from "./composer-popover-placement";

const anchor = (overrides: Partial<PopoverAnchorMetrics>): PopoverAnchorMetrics => ({
  cardTop: 600,
  caretTop: 700,
  viewportTop: 0,
  viewportBottom: 874,
  ...overrides,
});

describe("composerPopoverPlacement", () => {
  it("rises from the card's top edge, capped at the max height", () => {
    expect(composerPopoverPlacement(anchor({ cardTop: 800 }))).toEqual({
      bottom: 796,
      maxHeight: COMPOSER_POPOVER_MAX_HEIGHT,
    });
  });

  it("shrinks to the room above the card while that room is usable", () => {
    expect(composerPopoverPlacement(anchor({ cardTop: 200 }))).toEqual({
      bottom: 196,
      maxHeight: 188,
    });
  });

  it("rises from the caret's line, over the draft, when the room above the card is too short", () => {
    // Phone keyboard open, tall draft: the card starts 129px from the top,
    // which leaves less than COMPOSER_POPOVER_MIN_HEIGHT above it.
    expect(composerPopoverPlacement(anchor({ cardTop: 129, caretTop: 250 }))).toEqual({
      bottom: 246,
      maxHeight: 238,
    });
  });

  it("never covers the caret, and never leaves the screen", () => {
    const placement = composerPopoverPlacement(anchor({ cardTop: 40, caretTop: 90 }));
    expect(placement).toEqual({ bottom: 86, maxHeight: 78 });
    expect(placement.bottom - placement.maxHeight).toBeGreaterThanOrEqual(8);
    // A caret far down still caps the list at the max height.
    expect(composerPopoverPlacement(anchor({ cardTop: 100, caretTop: 600 }))).toEqual({
      bottom: 596,
      maxHeight: COMPOSER_POPOVER_MAX_HEIGHT,
    });
  });

  it("keeps a caret scrolled out of the editor's view above the keyboard", () => {
    // Keyboard up (visible viewport ends at 450), the editor scrolled so the
    // caret's line sits at 700, behind the keyboard.
    expect(
      composerPopoverPlacement(anchor({ cardTop: 129, caretTop: 700, viewportBottom: 450 })),
    ).toEqual({ bottom: 446, maxHeight: COMPOSER_POPOVER_MAX_HEIGHT });
  });

  it("stays above the card when the caret is out of the editor", () => {
    expect(composerPopoverPlacement(anchor({ cardTop: 100, caretTop: null }))).toEqual({
      bottom: 96,
      maxHeight: 88,
    });
  });

  it("measures the room from the visible viewport's top", () => {
    // iOS panned the visual viewport 100px down the layout viewport.
    expect(composerPopoverPlacement(anchor({ cardTop: 400, viewportTop: 100 }))).toEqual({
      bottom: 396,
      maxHeight: 288,
    });
  });
});
