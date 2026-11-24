import { useSyncExternalStore } from "react";
import { getDockedSidebarSnapshot, subscribeFormFactor } from "@/lib/form-factor";

function getServerSnapshot(): boolean {
  return false;
}

/**
 * `true` when the phone layout keeps the sidebar docked beside the page
 * (`lib/form-factor.ts`): a touch screen 900px wide or more, such as a
 * foldable unfolded on its side. The sidebar then collapses to the rail, as
 * on the desktop, instead of closing into the drawer.
 */
export function useDockedSidebar(): boolean {
  return useSyncExternalStore(subscribeFormFactor, getDockedSidebarSnapshot, getServerSnapshot);
}
