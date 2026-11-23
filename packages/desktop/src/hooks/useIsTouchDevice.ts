import { useSyncExternalStore } from "react";
import { getCoarsePointerSnapshot, subscribeFormFactor } from "@/lib/form-factor";

function getServerSnapshot(): boolean {
  return false;
}

/**
 * `true` when the primary pointer is a finger (`(pointer: coarse)`): phones and
 * tablets, with no hover and no right-click. Distinct from `useIsMobile`, the
 * phone layout: a narrow desktop window still has a mouse and a right-click,
 * and an iPad in landscape keeps the desktop layout under a finger. Reads the
 * form-factor store, so every consumer shares one set of media listeners.
 */
export function useIsTouchDevice(): boolean {
  return useSyncExternalStore(subscribeFormFactor, getCoarsePointerSnapshot, getServerSnapshot);
}
