import { translateUi } from "@/lib/i18n/ui";
/**
 * Noun describing a feature's live activity (running terminals and/or open
 * browser tabs) for the sidebar "Close …" action. Shared by the context-menu
 * item and the toast wording so they always agree. Callers must only invoke it
 * when at least one count is positive.
 */
export function closeFeatureActivityNoun(
  shellCount: number,
  browserCount: number,
  downloadCount = 0,
): string {
  const hasShells = shellCount > 0;
  const hasBrowsers = browserCount > 0;
  const browserActivity =
    hasShells && hasBrowsers
      ? translateUi("sidebar.activity.terminalsAndBrowsers", "terminals & browsers")
      : hasShells
        ? translateUi("sidebar.activity.terminals", "terminals", {
            count: shellCount,
            defaultValue_one: "terminal",
          })
        : hasBrowsers
          ? translateUi("sidebar.activity.browserTabs", "browser tabs", {
              count: browserCount,
              defaultValue_one: "browser tab",
            })
          : "";
  if (downloadCount <= 0) return browserActivity;
  const downloads = translateUi("sidebar.activity.downloads", "downloads", {
    count: downloadCount,
    defaultValue_one: "download",
  });
  return browserActivity
    ? translateUi("sidebar.activity.withDownloads", "{{activity}} & {{downloads}}", {
        activity: browserActivity,
        downloads,
      })
    : downloads;
}
