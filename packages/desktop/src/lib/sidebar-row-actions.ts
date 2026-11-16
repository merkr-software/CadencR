/** Actions a focused conversation row performs from a keyboard shortcut. */
export type SidebarRowAction = "pin" | "archive" | "label" | "move-up" | "move-down";

export const SIDEBAR_ROW_ACTION_EVENT = "cadencr-sidebar-row-action";

export interface SidebarRowActionDetail {
  action: SidebarRowAction;
  /** Set by the row that performed it; false means this row can't (e.g. archive from "For me"). */
  handled: boolean;
}

/**
 * Asks the row itself to act: it holds the project's callbacks (pin, archive,
 * label editor), which the sidebar-wide shortcut handler doesn't.
 */
export function dispatchSidebarRowAction(row: HTMLElement, action: SidebarRowAction): boolean {
  const detail: SidebarRowActionDetail = { action, handled: false };
  row.dispatchEvent(new CustomEvent(SIDEBAR_ROW_ACTION_EVENT, { detail }));
  return detail.handled;
}
