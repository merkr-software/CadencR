import { openExternalUrl } from "@/lib/open-external";
import { translateUi } from "@/lib/i18n/ui";

// Shared constants for the in-app changelog / news surface.
const CHANGELOG_URL = "https://cadencr.com/news";

/** localStorage key tracking the last `APP_VERSION` the user has seen. */
export const LAST_SEEN_VERSION_KEY = "cadencr.lastSeenAppVersion";

/**
 * Shared pill classes for the sidebar footer (Settings link, update
 * button). 90%-width, rounded-full, border invisible until hover/focus.
 */
export const SIDEBAR_FOOTER_PILL_CLASS =
  "flex w-[90%] items-center justify-between gap-2 rounded-full border border-transparent px-3 py-1.5 text-xs transition-colors hover:border-border hover:bg-accent hover:text-foreground focus-visible:border-border focus-visible:bg-accent focus-visible:outline-none";

export function openFullChangelog(): Promise<boolean> {
  return openExternalUrl(
    CHANGELOG_URL,
    translateUi("system.changelog.openError", "Could not open the changelog."),
  );
}
