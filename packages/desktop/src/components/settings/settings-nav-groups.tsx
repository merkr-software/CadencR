import type { SettingsNavGroup } from "@/components/settings/SettingsNavSidebar";
import { CUSTOM_TABS_SECTION_ID } from "@/components/settings/custom-tabs/custom-tab-model";
import { CUSTOM_ACTIONS_SECTION_ID } from "@/components/settings/CustomActionsSettingsSection";
import {
  BarChart3,
  Bell,
  Code2,
  GitMerge,
  Globe,
  HardDrive,
  Info,
  ListFilter,
  MonitorCog,
  Network,
  Palette,
  PanelLeft,
  Play,
  Plug,
  Puzzle,
  Tag,
} from "lucide-react";

/**
 * Left-rail structure for the settings page. Each `id` must match the `id` of a
 * `SettingsSection` rendered in `routes/settings.tsx` — that is what the rail's
 * scroll-tracking observes and what `?section=` deep-links resolve against.
 *
 * Lives outside the route file so adding a section does not push it past the
 * 400-line cap.
 */
export const NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: "General",
    items: [
      {
        id: "appearance",
        label: "Appearance",
        icon: <Palette className="size-4" />,
      },
      { id: "editor", label: "Editor", icon: <Code2 className="size-4" /> },
      {
        id: "interface",
        label: "Interface & Zoom",
        icon: <MonitorCog className="size-4" />,
      },
      {
        id: "sidebar-display",
        label: "Sidebar",
        icon: <PanelLeft className="size-4" />,
      },
      {
        id: "sidebar-views",
        label: "Saved views",
        icon: <ListFilter className="size-4" />,
      },
      {
        id: "notifications",
        label: "Notifications",
        icon: <Bell className="size-4" />,
      },
      {
        id: "browser",
        label: "Browser",
        icon: <Globe className="size-4" />,
      },
      // Beside Browser: both configure tabs of the conversation page.
      {
        id: CUSTOM_TABS_SECTION_ID,
        label: "Custom tabs",
        icon: <Puzzle className="size-4" />,
      },
      {
        id: CUSTOM_ACTIONS_SECTION_ID,
        label: "Custom actions",
        icon: <Play className="size-4" />,
      },
      {
        id: "storage",
        label: "Storage",
        icon: <HardDrive className="size-4" />,
      },
    ],
  },
  {
    label: "MCP",
    items: [
      {
        id: "mcp",
        label: "MCP",
        icon: <Network className="size-4" />,
      },
    ],
  },
  {
    label: "Agents",
    items: [
      {
        id: "auto-naming",
        label: "Auto-naming",
        icon: <Tag className="size-4" />,
      },
    ],
  },
  {
    label: "Source Control",
    items: [{ id: "git", label: "Git", icon: <GitMerge className="size-4" /> }],
  },
  {
    label: "Providers",
    items: [
      {
        id: "providers",
        label: "CLI Providers",
        icon: <Plug className="size-4" />,
      },
    ],
  },
  {
    label: "Usage",
    items: [
      {
        id: "stats",
        label: "Stats",
        icon: <BarChart3 className="size-4" />,
      },
    ],
  },
  {
    label: "About",
    items: [
      {
        id: "about",
        label: "About Cadencr",
        icon: <Info className="size-4" />,
      },
    ],
  },
];
