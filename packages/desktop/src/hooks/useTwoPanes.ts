import { useSyncExternalStore } from "react";
import { getTwoPanesSnapshot, subscribeFormFactor } from "@/lib/form-factor";

function getServerSnapshot(): boolean {
  return false;
}

/**
 * `true` when the phone layout has room for two panes (`lib/form-factor.ts`):
 * a touch screen 600px wide or more on a screen at least 600px on its short
 * side, such as a foldable unfolded (never a phone on its side). The inbox
 * then sits beside the conversation. Follows folding and rotation; the same
 * answer is on `<html data-panes>` for CSS.
 */
export function useTwoPanes(): boolean {
  return useSyncExternalStore(subscribeFormFactor, getTwoPanesSnapshot, getServerSnapshot);
}
