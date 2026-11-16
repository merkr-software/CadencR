import { useEffect, useRef, type RefObject } from "react";
import {
  SIDEBAR_ROW_ACTION_EVENT,
  type SidebarRowAction,
  type SidebarRowActionDetail,
} from "@/lib/sidebar-row-actions";

/**
 * What a row does for each shortcut; a missing action is one the row can't do.
 * A handler returns false when the row turns out not to support it after all.
 */
type SidebarRowActionHandlers = Partial<Record<SidebarRowAction, () => boolean | void>>;

/**
 * Lets a conversation row answer the row shortcuts (pin, archive, label, move). The
 * latest `handlers` are always used, so callers can pass inline functions.
 */
export function useSidebarRowActionListener(
  rowRef: RefObject<HTMLElement | null>,
  handlers: SidebarRowActionHandlers,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const onAction = (event: Event): void => {
      const detail = (event as CustomEvent<SidebarRowActionDetail>).detail;
      const handler = handlersRef.current[detail.action];
      if (!handler || handler() === false) return;
      detail.handled = true;
    };
    row.addEventListener(SIDEBAR_ROW_ACTION_EVENT, onAction);
    return () => row.removeEventListener(SIDEBAR_ROW_ACTION_EVENT, onAction);
  }, [rowRef]);
}
