import { useSyncExternalStore } from "react";
import { getTabRailSnapshot, subscribeFormFactor } from "@/lib/form-factor";
import { getSideStripSnapshot, subscribeSideStrip, type StripSide } from "@/lib/side-strip";

function subscribe(onChange: () => void): () => void {
  const stopStrip = subscribeSideStrip(onChange);
  const stopLayout = subscribeFormFactor(onChange);
  return () => {
    stopStrip();
    stopLayout();
  };
}

/** In the system's side strip first, else on the right where the layout has room. */
function getSnapshot(): StripSide | null {
  return getSideStripSnapshot() ?? (getTabRailSnapshot() ? "right" : null);
}

function getServerSnapshot(): null {
  return null;
}

/**
 * Where the conversation's tabs stand as a vertical rail, or null for the
 * bottom bar: inside the system's side strip (an iPhone Duo folded, or
 * unfolded on its side; `lib/side-strip.ts`, `<html data-side-strip>`), else
 * on the right of the pane on a touch screen in the phone layout 600px wide
 * or more (`lib/form-factor.ts`).
 */
export function useTabRail(): StripSide | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
