import type { ReactNode } from "react";
import {
  BarChart3,
  Bell,
  Bot,
  Code2,
  GitMerge,
  Globe,
  HardDrive,
  Info,
  Network,
  Palette,
  PanelLeft,
  Play,
  Plug,
  Puzzle,
  SlidersHorizontal,
} from "lucide-react";
import { FORGE_SETTINGS_ANCHOR } from "@/lib/settings-anchors";
import { SETTINGS_ANCHORS as A } from "./settings-anchor-ids";

/**
 * The settings page's map: which pages exist, how the rail groups them, and
 * every setting a search can land on. Kept free of the page components so the
 * command palette can import it without pulling every settings screen in.
 *
 * `?section=` accepts a page id, one of its `aliases` (the ids of sections that
 * were merged into it), or an entry's `anchor`. Each anchor must be rendered as
 * an element id by its page, or a deep link lands at the page's top.
 */

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
  pages: readonly SettingsPageMeta[];
}

const icon = (Glyph: typeof Palette): ReactNode => <Glyph className="size-4" aria-hidden />;

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  {
    label: "Preferences",
    pages: [
      {
        id: "general",
        label: "General",
        icon: icon(SlidersHorizontal),
        description:
          "Interface scale, keyboard shortcuts, restarts and the file every setting is saved in.",
        aliases: ["interface"],
        entries: [
          { label: "UI zoom", anchor: A.interface, keywords: ["scale", "zoom", "font size"] },
          { label: "Keyboard shortcuts", anchor: A.keyboard, keywords: ["hotkeys", "keybindings"] },
          {
            label: "Resume agents after a restart",
            anchor: A.restarts,
            keywords: ["update", "crash", "continue"],
          },
          {
            label: "Configuration file",
            anchor: A.settingsFile,
            keywords: ["settings.json", "json", "edit", "path"],
          },
        ],
      },
      {
        id: "appearance",
        label: "Appearance",
        icon: icon(Palette),
        description: "Theme, motion, the typeface used for code and how agent transcripts read.",
        entries: [
          { label: "Theme", anchor: A.theme, keywords: ["dark", "light", "colors"] },
          { label: "Fluid animations", anchor: A.theme, keywords: ["motion", "reduced motion"] },
          { label: "Monospace font", anchor: A.font, keywords: ["typeface", "code font"] },
          { label: "Theme library", anchor: A.themeLibrary, keywords: ["custom theme", "create"] },
          {
            label: "Agent output verbosity",
            anchor: A.agentOutput,
            keywords: ["maximal", "minimal", "compact", "transcript", "tool calls"],
          },
          { label: "Summary mode", anchor: A.agentOutput, keywords: ["recap"] },
          { label: "Message navigator", anchor: A.agentOutput, keywords: ["ticks", "jump"] },
        ],
      },
      {
        id: "sidebar",
        label: "Sidebar",
        icon: icon(PanelLeft),
        description:
          "How conversations are listed. The sliders button in the sidebar's Projects header edits the same options; changes apply at once and follow you to remote devices. Point at an option to see what it changes in the preview.",
        wide: true,
        aliases: ["sidebar-display"],
        entries: [
          { label: "Sidebar presets", keywords: ["classic", "focus", "supervise", "detailed"] },
          { label: "Density", keywords: ["compact", "row height", "text size"] },
          { label: "Block order", keywords: ["pinned", "for me", "recent"] },
          { label: "Collapsed rail", keywords: ["rail", "collapse"] },
          { label: "Saved views", anchor: A.sidebarViews, keywords: ["query", "filter", "lens"] },
        ],
      },
      {
        id: "notifications",
        label: "Notifications",
        icon: icon(Bell),
        description: "Where Cadencr tells you an agent finished or needs you.",
        entries: [
          { label: "Notification destination", anchor: A.notificationDestination },
          {
            label: "Push notifications",
            anchor: A.push,
            keywords: ["phone", "remote", "pwa"],
            requires: "remote-browser",
          },
          {
            label: "Notch island",
            anchor: A.notch,
            keywords: ["macos", "display", "island"],
            requires: "macos-desktop",
          },
          {
            label: "Send test notification",
            anchor: A.notificationTest,
            keywords: ["debug"],
            requires: "desktop-shell",
          },
        ],
      },
    ],
  },
  {
    label: "Agents",
    pages: [
      {
        id: "agents",
        label: "Agents",
        icon: icon(Bot),
        description:
          "What applies to every agent, whichever provider runs it. New conversations start on the model you last used; switch it from the composer.",
        aliases: ["auto-naming"],
        entries: [
          {
            label: "Conversation names",
            anchor: A.autoNaming,
            keywords: ["auto-naming", "title", "naming model", "naming prompt"],
          },
        ],
      },
      {
        id: "providers",
        label: "Providers",
        icon: icon(Plug),
        description:
          "The agent CLIs Cadencr runs: their versions, which install is used, profiles, models and permissions.",
        entries: [
          { label: "Provider versions & updates", keywords: ["upgrade", "cli version"] },
          {
            label: "Claude Code",
            anchor: A.providerConfig,
            keywords: ["profiles", "custom models", "bypass permissions", "binary"],
          },
          { label: "Codex", anchor: A.providerConfig, keywords: ["profiles", "access mode"] },
          { label: "Cursor", anchor: A.providerConfig, keywords: ["agent cli", "access mode"] },
          { label: "OpenCode", anchor: A.providerConfig, keywords: ["binary"] },
          {
            label: "Build a provider connector",
            anchor: A.providerConnector,
            keywords: ["acp", "plugin", "developer"],
          },
        ],
      },
      {
        id: "mcp",
        label: "MCP servers",
        icon: icon(Network),
        description:
          "Cadencr's own tool servers, offered to every agent you run. A change takes effect on the agent's next turn.",
        entries: [
          { label: "Browser tools for agents", keywords: ["cadencr-browser", "mcp"] },
          { label: "Project coordination for agents", keywords: ["cadencr-project", "spawn"] },
          { label: "Workspace memory for agents", keywords: ["cadencr-workspace", "history"] },
        ],
      },
    ],
  },
  {
    label: "Tools",
    pages: [
      {
        id: "editor",
        label: "Editor",
        icon: icon(Code2),
        description: "The built-in code editor, its language servers and the file tree.",
        entries: [
          { label: "Vim mode", anchor: A.editing, keywords: ["neovim", "vim motions"] },
          { label: "Auto-save", anchor: A.editing },
          { label: "Git blame", anchor: A.editing, keywords: ["annotation"] },
          { label: "Max open tabs", anchor: A.editing, keywords: ["tab limit"] },
          { label: "Language servers", anchor: A.lsp, keywords: ["lsp", "go to definition"] },
          { label: "File tree icons", anchor: A.fileTree, keywords: ["icon theme"] },
        ],
      },
      {
        id: "git",
        label: "Git",
        icon: icon(GitMerge),
        description: "Merging, diffs, and the hosts behind your remotes.",
        entries: [
          { label: "Merge strategy", anchor: A.merge, keywords: ["squash", "rebase", "no-ff"] },
          { label: "Diff layout", anchor: A.diff, keywords: ["split", "unified"] },
          {
            label: "Remote connections",
            anchor: FORGE_SETTINGS_ANCHOR,
            keywords: ["github", "gitlab", "bitbucket", "pull request", "token", "forge"],
          },
        ],
      },
      {
        id: "browser",
        label: "Browser",
        icon: icon(Globe),
        description:
          "The Browser tab: when it opens beside the agent, which cookies it keeps, how it searches, and which links it catches.",
        entries: [
          {
            label: "Auto layout",
            anchor: A.browserLayout,
            keywords: ["split", "reveal"],
            requires: "wide-screen",
          },
          {
            label: "Default browser mode",
            anchor: A.browserMode,
            keywords: ["private", "cookies"],
          },
          { label: "Search engine", anchor: A.browserSearch, keywords: ["google", "duckduckgo"] },
          {
            label: "Open in Cadencr's browser",
            anchor: A.browserDomains,
            keywords: ["domains", "links"],
          },
        ],
      },
      {
        id: "custom-tabs",
        label: "Custom tabs",
        icon: icon(Puzzle),
        description:
          "Web apps you build that open as tabs in a conversation, next to Agent, Terminal and Git. Each one only sees what you allow. Desktop only.",
        entries: [{ label: "Create custom tab", keywords: ["plugin", "extension"] }],
      },
      {
        id: "actions",
        label: "Custom actions",
        icon: icon(Play),
        description:
          "Commands you run often in a conversation's working copy: tests, linters, deploys, dev servers.",
        entries: [{ label: "Custom actions", keywords: ["scripts", "run", "commands"] }],
      },
    ],
  },
  {
    label: "System",
    pages: [
      {
        id: "stats",
        label: "Usage",
        icon: icon(BarChart3),
        description:
          "Provider-reported tokens and the messages you send, kept apart from your conversations: archiving or deleting one doesn't erase them.",
        entries: [{ label: "Usage stats", keywords: ["tokens", "messages", "chart"] }],
      },
      {
        id: "storage",
        label: "Storage",
        icon: icon(HardDrive),
        description:
          "Cadencr always de-duplicates terminal output and moves pasted images to disk; neither loses anything. Compaction is the one pass that shortens content, and it is off until you turn it on.",
        entries: [
          { label: "Compact archived features", keywords: ["retention", "cleanup", "disk"] },
        ],
      },
      {
        id: "about",
        label: "About",
        icon: icon(Info),
        description: "Version, updates and diagnostics.",
        entries: [
          { label: "Check for updates", keywords: ["version", "upgrade"] },
          { label: "Export diagnostics", anchor: A.diagnostics, keywords: ["logs", "bug report"] },
        ],
      },
    ],
  },
];

export const SETTINGS_PAGES: readonly SettingsPageMeta[] = SETTINGS_NAV_GROUPS.flatMap(
  (group) => group.pages,
);

/** A page's catalog entry; every `SettingsPageId` has one. */
export function settingsPageMeta(id: SettingsPageId): SettingsPageMeta {
  const page = SETTINGS_PAGES.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`Settings page "${id}" is missing from the catalog`);
  return page;
}

export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "general";

export interface ResolvedSettingsTarget {
  page: SettingsPageMeta;
  /** Element to scroll to inside the page; none means the page's top. */
  anchor: string | null;
}

/**
 * What a `?section=` value opens. Unknown values resolve to nothing so the
 * caller can fall back to its default page instead of an empty screen.
 */
export function resolveSettingsTarget(section: string | undefined): ResolvedSettingsTarget | null {
  if (!section) return null;
  for (const page of SETTINGS_PAGES) {
    if (page.id === section) return { page, anchor: null };
    if (page.aliases?.includes(section)) return { page, anchor: section };
    if (page.entries.some((entry) => entry.anchor === section)) return { page, anchor: section };
  }
  return null;
}
