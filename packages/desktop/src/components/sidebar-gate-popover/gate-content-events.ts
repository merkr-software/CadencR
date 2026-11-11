import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Marks the deny feedback field, whose Escape cancels the field and not the quick reply. */
export const DENY_FIELD_ATTRIBUTE = "data-gate-deny-field";

/**
 * Radix closes a popover or dialog on Escape before any React handler runs. In
 * the deny feedback field Escape only cancels the field: preventing the event
 * here keeps Radix from dismissing, and the field's own handler cancels.
 */
export function keepEscapeInDenyField(event: KeyboardEvent): void {
  if (event.target instanceof Element && event.target.closest(`[${DENY_FIELD_ATTRIBUTE}]`)) {
    event.preventDefault();
  }
}

/**
 * The quick reply renders in a portal, but React still bubbles its keys through
 * the sidebar that hosts it, whose type-to-filter would take them. Keys with a
 * Ctrl, Meta or Alt modifier keep going: those are global shortcuts.
 */
export function keepTypingInQuickReply(event: ReactKeyboardEvent): void {
  if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
}
