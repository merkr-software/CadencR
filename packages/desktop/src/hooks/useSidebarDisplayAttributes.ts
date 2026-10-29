import { useEffect, type CSSProperties, type RefObject } from "react";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarPreviewStore } from "@/stores/sidebar-preview-store";

/**
 * Root attributes the row CSS keys off (`sidebar-rows.css`, `sidebar-row-height.css`,
 * `sidebar-row-colors.css`), so rows never
 * re-render for them: on the sidebar and on the Settings page's preview.
 */
export function useSidebarDisplayAttributes(): {
  "data-sidebar-density": string;
  "data-sidebar-title-lines": string;
  "data-sidebar-row-height": string;
  "data-sidebar-color": string;
  style: CSSProperties;
} {
  const density = useSidebarOption("density");
  const titleLines = useSidebarOption("titleLines");
  const rowHeight = useSidebarOption("rowHeight");
  const fontSize = useSidebarOption("fontSize");
  const colorMode = useSidebarOption("colorMode");
  return {
    "data-sidebar-density": density,
    // A fixed row height keeps every title to one line: a second one would be empty on short titles.
    "data-sidebar-title-lines": rowHeight === "fixed" ? "one" : titleLines,
    "data-sidebar-row-height": rowHeight,
    "data-sidebar-color": colorMode,
    // In rem, so the rows follow the app zoom like the rest of the sidebar.
    style: { "--sidebar-row-font": `${Number(fontSize) / 16}rem` } as CSSProperties,
  };
}

/**
 * Names the display option being pointed at on `ref` (`data-sidebar-highlight`),
 * outlined in the rows by CSS. Written straight to the DOM: moving across the
 * options must not re-render the whole sidebar.
 */
export function useSidebarHighlightAttribute(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const apply = (highlight: string | null) => {
      const element = ref.current;
      if (!element) return;
      if (highlight) element.dataset.sidebarHighlight = highlight;
      else delete element.dataset.sidebarHighlight;
    };
    apply(useSidebarPreviewStore.getState().highlight);
    return useSidebarPreviewStore.subscribe((state, previous) => {
      if (state.highlight !== previous.highlight) apply(state.highlight);
    });
  }, [ref]);
}
