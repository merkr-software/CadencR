import { SIDEBAR_VIEWS_SETTINGS_ANCHOR } from "@/lib/settings-anchors";

/**
 * Element ids inside settings pages that search results and `?section=` deep
 * links scroll to. The catalog names them and the pages render them from this
 * one table, so a renamed id can't silently strand a link at the page's top.
 * Ids that outside code links to live in `@/lib/settings-anchors`.
 */
export const SETTINGS_ANCHORS = {
  interface: "interface",
  keyboard: "keyboard",
  settingsFile: "settings-file",
  theme: "theme",
  font: "monospace-font",
  themeLibrary: "theme-library",
  sidebarViews: SIDEBAR_VIEWS_SETTINGS_ANCHOR,
  notificationDestination: "notification-destination",
  push: "push-notifications",
  notch: "notch-island",
  notificationTest: "notification-test",
  agentOutput: "agent-output",
  autoNaming: "auto-naming",
  restarts: "agent-restarts",
  providerConfig: "provider-config",
  providerConnector: "provider-connector",
  editing: "editing",
  lsp: "language-servers",
  fileTree: "file-tree",
  merge: "merge-strategy",
  diff: "diff-layout",
  browserLayout: "browser-layout",
  browserMode: "browser-mode",
  browserSearch: "browser-search",
  browserDomains: "browser-domains",
  diagnostics: "diagnostics",
} as const;
