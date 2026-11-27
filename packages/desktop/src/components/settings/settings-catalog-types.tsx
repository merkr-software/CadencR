import type { ReactNode } from "react";
import type { Palette } from "lucide-react";
export { localizedSearchKeywords as settingsKeywords } from "@/lib/i18n/search-keywords";

export type SettingsTranslator = (key: string, defaultValue: string) => string;

export type SettingsPageId =
  | "general"
  | "appearance"
  | "sidebar"
  | "notifications"
  | "agents"
  | "providers"
  | "mcp"
  | "editor"
  | "git"
  | "browser"
  | "custom-tabs"
  | "actions"
  | "stats"
  | "storage"
  | "about";

/** Where a setting renders at all; search and the palette hide it elsewhere. */
export type SettingsRequirement =
  | "desktop-shell"
  | "macos-desktop"
  | "remote-browser"
  | "wide-screen";

export interface SettingsEntry {
  /** What the search shows and matches first. */
  label: string;
  englishLabel?: string;
  /** Element id on the page to scroll to; the page's top when absent. */
  anchor?: string;
  /** Other words people use for this setting. */
  keywords?: readonly string[];
  /** Set when the page only renders this setting on some clients. */
  requires?: SettingsRequirement;
}

export interface SettingsPageMeta {
  id: SettingsPageId;
  label: string;
  englishLabel?: string;
  icon: ReactNode;
  /** The page's purpose, under its title; also the palette command's description. */
  description: string;
  /**
   * A wider column, for a page with a live preview beside its settings: in the
   * default width the cards next to it are too narrow to keep a control
   * beside its label.
   */
  wide?: boolean;
  /** Ids of retired sections that now open this page (old deep links). */
  aliases?: readonly string[];
  entries: readonly SettingsEntry[];
}

export interface SettingsNavGroup {
  label: string;
  englishLabel?: string;
  pages: readonly SettingsPageMeta[];
}

export const settingsIcon = (Glyph: typeof Palette): ReactNode => (
  <Glyph className="size-4" aria-hidden />
);

export function settingsLabel(t: SettingsTranslator, key: string, englishLabel: string) {
  const label = t(key, englishLabel);
  return label === englishLabel ? { label } : { label, englishLabel };
}
