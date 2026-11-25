import type { BrowserTabMetadata } from "@/lib/desktop-bridge";
import type { UiTranslator } from "@/lib/i18n/ui";

export function browserTabLabel(
  tab: Pick<BrowserTabMetadata, "title" | "url" | "defaultTitle">,
  t: UiTranslator,
): string {
  if (
    !tab.title ||
    tab.defaultTitle ||
    (tab.defaultTitle === undefined &&
      tab.title === "New tab" &&
      (!tab.url || tab.url === "about:blank"))
  ) {
    return t("workspace.browser.newTab", "New tab");
  }
  return tab.title;
}
