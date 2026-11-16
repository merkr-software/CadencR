import { useEffect, useMemo, type FocusEvent } from "react";
import { SIDEBAR_OPTIONS, type SidebarOptionId } from "@/lib/sidebar-config";
import { useSidebarPreviewStore } from "@/stores/sidebar-preview-store";

function isSidebarOptionId(value: string): value is SidebarOptionId {
  return Object.hasOwn(SIDEBAR_OPTIONS, value);
}

function optionAt(target: EventTarget | null): SidebarOptionId | null {
  const row =
    target instanceof Element ? target.closest<HTMLElement>("[data-sidebar-option]") : null;
  const id = row?.dataset.sidebarOption;
  return id && isSidebarOptionId(id) ? id : null;
}

/**
 * Handlers for a display options form: the option row under the pointer or
 * holding focus (marked `data-sidebar-option`) is outlined in the sidebar and
 * the preview, so each option shows what it changes before it is changed.
 */
export function useSidebarOptionHighlight(): {
  onPointerOver: (event: { target: EventTarget | null }) => void;
  onPointerLeave: () => void;
  onFocus: (event: FocusEvent) => void;
  onBlur: (event: FocusEvent) => void;
} {
  const setHighlight = useSidebarPreviewStore((state) => state.setHighlight);
  useEffect(() => () => setHighlight(null), [setHighlight]);
  return useMemo(
    () => ({
      // The gaps between rows point at no option: keep the last one rather than flicker.
      onPointerOver: (event) => {
        const option = optionAt(event.target);
        if (option) setHighlight(option);
      },
      onPointerLeave: () => setHighlight(null),
      onFocus: (event) => setHighlight(optionAt(event.target)),
      onBlur: (event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setHighlight(null);
      },
    }),
    [setHighlight],
  );
}
