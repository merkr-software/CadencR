import { translateUi } from "../../src/shared/ui-i18n";

export function unknownBrowserTab(tabId: string): Error {
  return new Error(
    translateUi("workspace.browser.tab.unknown", "Unknown browser tab: {{tabId}}", { tabId }),
  );
}
