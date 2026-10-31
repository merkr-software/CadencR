const FLASH_ATTRIBUTE = "data-settings-flash";
const FLASH_MS = 1600;
const timers = new WeakMap<Element, number>();

/**
 * Scrolls a setting's anchor into view and outlines it for a moment, so a
 * search result or deep link shows *which* group it meant, not just a page
 * scrolled somewhere. The anchor is looked up inside `root` (the settings
 * page), never document-wide: app chrome can share a setting's id. Returns
 * false when the page doesn't render that anchor (an option that doesn't apply
 * on this platform), leaving the caller to show the page's top instead.
 */
export function revealSettingsAnchor(id: string, root: ParentNode): boolean {
  const element = root.querySelector(`[id="${id.replace(/["\\]/g, "\\$&")}"]`);
  if (!element) return false;
  element.scrollIntoView({ block: "start" });
  window.clearTimeout(timers.get(element));
  // Restart the animation when the same anchor is revealed twice in a row.
  element.removeAttribute(FLASH_ATTRIBUTE);
  void element.getBoundingClientRect();
  element.setAttribute(FLASH_ATTRIBUTE, "");
  timers.set(
    element,
    window.setTimeout(() => element.removeAttribute(FLASH_ATTRIBUTE), FLASH_MS),
  );
  return true;
}

/** Shows a settings target: its anchor when there is one and it renders, else the page's top. */
export function showSettingsTarget(main: HTMLElement, anchor: string | null): void {
  if (!anchor || !revealSettingsAnchor(anchor, main)) main.scrollTop = 0;
}
