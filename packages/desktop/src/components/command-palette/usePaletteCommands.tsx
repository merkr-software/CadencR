import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import {
  AtSignIcon,
  BlocksIcon,
  CalendarClockIcon,
  FolderPlusIcon,
  HashIcon,
  LayoutGridIcon,
  MessageSquarePlusIcon,
  PaletteIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import type { Project } from "@/api/generated";
import { NAV_GROUPS } from "@/components/settings/settings-nav-groups";
import { PALETTE_SHORTCUT_ICONS } from "@/components/command-palette/palette-shortcut-icons";
import {
  isPaletteShortcut,
  PALETTE_SHORTCUT_COMMANDS,
  type PaletteShortcutId,
} from "@/lib/command-palette/palette-shortcut-commands";
import { runShortcutAction, useShortcutActionStore } from "@/lib/command-palette/shortcut-actions";
import type { PaletteCommand } from "@/lib/command-palette/palette-types";
import { isDesktopShell } from "@/lib/desktop-bridge";
import type { ShortcutId } from "@/lib/shortcuts/registry";

export interface PaletteCommandContext {
  activeProjectId: number | null;
  activeFeatureId: number | null;
  projects: readonly Project[];
  createConversation: (projectId: number) => void;
  addProject: () => void;
}

type Navigate = ReturnType<typeof useNavigate>;

function navigationCommands(navigate: Navigate): PaletteCommand[] {
  return [
    {
      id: "go-agents",
      title: "Agents",
      group: "Navigate",
      icon: <LayoutGridIcon />,
      keywords: ["unified", "grid", "all agents", "overview"],
      shortcutId: "open-unified-agents",
      description: "Every active agent at once, the ones that need you first.",
      run: () => navigate({ to: "/agents" }),
    },
    {
      id: "go-schedules",
      title: "Schedules",
      group: "Navigate",
      icon: <CalendarClockIcon />,
      keywords: ["cron", "recurring", "automation", "timer"],
      shortcutId: "open-schedules",
      description: "Prompts that run on a schedule.",
      run: () => navigate({ to: "/schedules" }),
    },
    {
      id: "go-settings",
      title: "Settings",
      group: "Navigate",
      icon: <SettingsIcon />,
      keywords: ["preferences", "options", "config"],
      shortcutId: "open-settings",
      description: "Global settings.",
      run: () => navigate({ to: "/settings" }),
    },
    {
      id: "go-marketplace",
      title: "Marketplace",
      group: "Navigate",
      icon: <BlocksIcon />,
      keywords: ["plugins", "themes", "providers", "extensions"],
      description: "Themes and provider connectors from the signed catalog.",
      run: () => navigate({ to: "/marketplace" }),
    },
  ];
}

/** One command per settings section: "Appearance", "Git"… straight to its anchor. */
function settingsCommands(navigate: Navigate): PaletteCommand[] {
  return NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      id: `settings-${item.id}`,
      title: `Settings: ${item.label}`,
      group: "Settings" as const,
      icon: item.icon,
      keywords: [group.label, "settings", "preferences"],
      description: `Open the ${item.label} section of Settings.`,
      run: () => navigate({ to: "/settings", search: { section: item.id } }),
    })),
  );
}

function createCommands(context: PaletteCommandContext): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  const current = context.projects.find((project) => project.id === context.activeProjectId);
  if (current) {
    commands.push({
      id: "new-conversation-here",
      title: `New conversation in ${current.name}`,
      group: "Create",
      icon: <SquarePenIcon />,
      keywords: ["session", "feature", "chat", "agent", "start"],
      shortcutId: "new-session",
      description: "Starts right away with the project's usual worktree setting.",
      run: () => context.createConversation(current.id),
    });
  }
  commands.push({
    id: "new-conversation",
    title: "New conversation…",
    group: "Create",
    icon: <MessageSquarePlusIcon />,
    keywords: ["session", "feature", "worktree", "branch", "project"],
    description:
      "Pick the project, then a new worktree, the project directory or an existing branch.",
    step: { kind: "new-conversation" },
  });
  if (isDesktopShell()) {
    commands.push({
      id: "add-project",
      title: "Add project…",
      group: "Create",
      icon: <FolderPlusIcon />,
      keywords: ["new project", "folder", "repository", "open"],
      description: "Choose a folder to add as a project.",
      run: context.addProject,
    });
  }
  return commands;
}

function modeCommands(context: PaletteCommandContext): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  if (context.activeFeatureId != null) {
    commands.push({
      id: "go-to-file",
      title: "Go to file…",
      group: "Navigate",
      icon: <AtSignIcon />,
      keywords: ["open", "find file", "fuzzy", "quick open"],
      description: "Search this conversation's worktree by file name. Type @ anywhere to start.",
      mode: "files",
    });
  }
  commands.push(
    {
      id: "search-messages",
      title: "Search messages…",
      group: "Navigate",
      icon: <HashIcon />,
      keywords: ["full text", "history", "find", "said", "transcript"],
      description: "Find the conversation where something was said. Type # anywhere to start.",
      mode: "messages",
    },
    {
      id: "change-theme",
      title: "Change theme…",
      group: "View",
      icon: <PaletteIcon />,
      keywords: ["appearance", "dark", "light", "colors"],
      description: "Preview each theme as you move through the list.",
      step: { kind: "theme" },
    },
  );
  return commands;
}

/**
 * The shortcuts something can run right now, under the palette's wording.
 * Conversation commands need one open: their handlers act on it.
 */
function shortcutCommands(
  registered: readonly ShortcutId[],
  inConversation: boolean,
): PaletteCommand[] {
  return registered.filter(isPaletteShortcut).flatMap((id) => {
    const meta = PALETTE_SHORTCUT_COMMANDS[id];
    if (meta.group === "Conversation" && !inConversation) return [];
    return [shortcutCommand(id)];
  });
}

function shortcutCommand(id: PaletteShortcutId): PaletteCommand {
  const meta = PALETTE_SHORTCUT_COMMANDS[id];
  return {
    id: `shortcut-${id}`,
    title: meta.title,
    group: meta.group,
    icon: PALETTE_SHORTCUT_ICONS[id],
    keywords: "keywords" in meta ? meta.keywords : undefined,
    shortcutId: id,
    run: () => {
      // The handler unmounted between opening the palette and picking.
      if (!runShortcutAction(id))
        toast.error(`${meta.title.replace(/…$/, "")} isn't available here anymore`);
    },
  };
}

export interface PaletteCommandSet {
  all: readonly PaletteCommand[];
  /** The few the empty palette offers. */
  suggestions: readonly PaletteCommand[];
}

export function usePaletteCommands(context: PaletteCommandContext): PaletteCommandSet {
  const navigate = useNavigate();
  const ids = useShortcutActionStore(
    useShallow((state) => Object.keys(state.byId) as ShortcutId[]),
  );
  return useMemo(() => {
    const all = [
      ...createCommands(context),
      ...modeCommands(context),
      ...navigationCommands(navigate),
      ...shortcutCommands(ids, context.activeFeatureId != null),
      ...settingsCommands(navigate),
    ];
    const byId = new Map(all.map((command) => [command.id, command]));
    const suggestions = [
      byId.get("new-conversation-here") ?? byId.get("new-conversation"),
      byId.get("go-to-file"),
      byId.get("search-messages"),
      byId.get("go-agents"),
    ].filter((command): command is PaletteCommand => command !== undefined);
    return { all, suggestions };
  }, [context, ids, navigate]);
}
