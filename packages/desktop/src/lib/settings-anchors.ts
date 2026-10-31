/**
 * Scroll anchors for `/settings?section=…` deep links. The settings page
 * resolves the param with `getElementById`, so a link naming an id that no
 * longer exists fails silently — it lands the user at the top of the page.
 * Deep links from outside settings name their anchor here and the target
 * renders it from the same constant.
 */

/** The "Remote connections" group inside the Git section — forge onboarding. */
export const FORGE_SETTINGS_ANCHOR = "git-remotes";

/** The "Saved views" group on the Sidebar page — the lens menu's "Edit views…". */
export const SIDEBAR_VIEWS_SETTINGS_ANCHOR = "sidebar-views";

/** The "Versions & updates" card leads the Providers section. */
export const PROVIDER_UPDATES_SETTINGS_ANCHOR = "providers";
