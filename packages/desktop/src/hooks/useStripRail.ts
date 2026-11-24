import { useSyncExternalStore } from "react";
import { getStripRailSnapshot, subscribeSideStrip, type StripSide } from "@/lib/side-strip";

function getServerSnapshot(): null {
  return null;
}

/**
 * Where the conversation's tab bar sits as a vertical rail in the system's
 * side strip (an iPhone Duo folded, or unfolded on its side; `lib/side-strip.ts`),
 * or null for the bottom bar. The same answer is on `<html data-strip-rail>`.
 */
export function useStripRail(): StripSide | null {
  return useSyncExternalStore(subscribeSideStrip, getStripRailSnapshot, getServerSnapshot);
}
