import { useCallback, useRef } from "react";
import {
  takeFocusBeforeUserOpen,
  usePendingGatePopoverStore,
  type GatePopoverOrigin,
} from "@/stores/pending-gate-popover-store";

/**
 * `onCloseAutoFocus` for a quick reply's popover or sheet. They have no Radix
 * trigger to return focus to, so Radix's own return is always cancelled. One
 * the user opened gives focus back to what had it before (the icon they
 * clicked, the field a shortcut left), unless focus has moved on meanwhile.
 * One that opened by itself, or by hovering, never touches focus.
 * `origin` is the open origin, or null once closed (the last one is kept for
 * the closing animation).
 */
export function useGateCloseFocus(origin: GatePopoverOrigin | null): (event: Event) => void {
  const shownOrigin = useRef(origin);
  if (origin) shownOrigin.current = origin;
  return useCallback((event: Event) => {
    event.preventDefault();
    if (shownOrigin.current !== "user") return;
    // Another quick reply took over (queue arrows, advance after an answer):
    // what had focus before the first one is still to come back to, later.
    if (usePendingGatePopoverStore.getState().open !== null) return;
    const target = takeFocusBeforeUserOpen();
    const closing = event.target instanceof Node ? event.target : null;
    const active = document.activeElement;
    const focusLost = !active || active === document.body || closing?.contains(active) === true;
    if (focusLost && target?.isConnected) target.focus();
  }, []);
}
