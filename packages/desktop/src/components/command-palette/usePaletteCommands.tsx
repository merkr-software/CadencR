import { translateUi, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
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
  SquareTerminalIcon,
} from "lucide-react";
import type { Project } from "@/api/generated";
import {
  availableSettingsGroups,
  currentSettingsPlatform,
} from "@/components/settings/settings-availability";
import { settingsNavGroups } from "@/components/settings/settings-catalog";
import { localizedSearchKeywords } from "@/lib/i18n/search-keywords";
import { isMobileViewport } from "@/hooks/useIsMobile";
import { PALETTE_SHORTCUT_ICONS } from "@/components/command-palette/palette-shortcut-icons";
import {
  isPaletteShortcut,
  PALETTE_SHORTCUT_COMMANDS,
  type PaletteShortcutId,
} from "@/lib/command-palette/palette-shortcut-commands";
import { runShortcutAction, useShortcutActionStore } from "@/lib/command-palette/shortcut-actions";
import { useCustomActionPaletteStore } from "@/lib/custom-actions/palette-commands";
import type { PaletteCommand } from "@/lib/command-palette/palette-types";
import { isDesktopShell } from "@/lib/desktop-bridge";
import { slugify } from "@/lib/utils";
import type { ShortcutId } from "@/lib/shortcuts/registry";

export interface PaletteCommandContext {
  activeProjectId: number | null;
  activeFeatureId: number | null;
  projects: readonly Project[];
  createConversation: (projectId: number) => void;
  addProject: () => void;
  installCli: () => void;
}

type Navigate = ReturnType<typeof useNavigate>;

function navigationCommands(navigate: Navigate, t: UiTranslator): PaletteCommand[] {
  return [
    {
      id: "go-agents",
      title: t("palette.commands.go-agents.title", "Agents"),
      group: "Navigate",
      icon: <LayoutGridIcon />,
      keywords: localizedSearchKeywords(
        t,
        "palette.commands.go-agents.keywords",
        "unified, grid, all agents, overview",
      ),
      shortcutId: "open-unified-agents",
      description: t(
        "palette.commands.go-agents.description",
        "Every active agent at once, the ones that need you first.",
      ),
      run: () => navigate({ to: "/agents" }),
    },
    {
      id: "go-schedules",
      title: t("palette.commands.go-schedules.title", "Schedules"),
      group: "Navigate",
      icon: <CalendarClockIcon />,
      keywords: localizedSearchKeywords(
        t,
        "palette.commands.go-schedules.keywords",
        "cron, recurring, automation, timer",
      ),
      shortcutId: "open-schedules",
      description: t(
        "palette.commands.go-schedules.description",
        "Prompts that run on a schedule.",
      ),
      run: () => navigate({ to: "/schedules" }),
    },
    {
      id: "go-settings",
      title: t("palette.commands.go-settings.title", "Settings"),
      group: "Navigate",
      icon: <SettingsIcon />,
      keywords: localizedSearchKeywords(
        t,
        "palette.commands.go-settings.keywords",
        "preferences, options, config",
      ),
      shortcutId: "open-settings",
      description: t("palette.commands.go-settings.description", "Global settings."),
      run: () => navigate({ to: "/settings" }),
    },
    {
      id: "go-marketplace",
      title: t("palette.commands.go-marketplace.title", "Marketplace"),
      group: "Navigate",
      icon: <BlocksIcon />,
      keywords: localizedSearchKeywords(
        t,
        "palette.commands.go-marketplace.keywords",
        "plugins, themes, providers, extensions",
      ),
      description: t(
        "palette.commands.go-marketplace.description",
        "Themes and provider connectors from the signed catalog.",
      ),
      run: () => navigate({ to: "/marketplace" }),
    },
  ];
}

/**
 * One command per settings page ("Settings: Appearance") and per indexed
 * setting ("Settings: Vim mode"), each opening its page at that setting.
 */
/** One command per settings page, and one per setting this client renders. */
export function settingsCommands(
  navigate: Navigate,
  t: UiTranslator = translateUi,
): PaletteCommand[] {
  const groups = availableSettingsGroups(
    currentSettingsPlatform(isMobileViewport()),
    settingsNavGroups(t),
  );
  return groups.flatMap((group) =>
    group.pages.flatMap((page) => [
      {
        id: `settings-${page.id}`,
        title: t("palette.settings.title", "Settings: {{label}}", { label: page.label }),
        group: "Settings" as const,
        icon: page.icon,
        keywords: [
          group.label,
          group.englishLabel ?? "",
          page.englishLabel ?? "",
          "settings",
          "preferences",
          ...(page.aliases ?? []),
        ],
        description: page.description,
        run: () => navigate({ to: "/settings", search: { section: page.id } }),
      },
      ...page.entries
        // A page-named entry would only repeat the page's own command.
        .filter(
          (entry) => (entry.englishLabel ?? entry.label) !== (page.englishLabel ?? page.label),
        )
        .map((entry) => ({
          id: `settings-${page.id}-${slugify(entry.englishLabel ?? entry.label)}`,
          title: t("palette.settings.title", "Settings: {{label}}", { label: entry.label }),
          group: "Settings" as const,
          icon: page.icon,
          keywords: [
            page.label,
            page.englishLabel ?? "",
            entry.englishLabel ?? "",
            "settings",
            ...(entry.keywords ?? []),
          ],
          description: t("palette.settings.description", "In {{page}} settings.", {
            page: page.label,
          }),
          run: () => navigate({ to: "/settings", search: { section: entry.anchor ?? page.id } }),
        })),
    ]),
  );
}

function createCommands(context: PaletteCommandContext, t: UiTranslator): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  const current = context.projects.find((project) => project.id === context.activeProjectId);
  if (current) {
    commands.push({
      id: "new-conversation-here",
      title: t("palette.commands.new-conversation-here.title", "New conversation in {{project}}", {
        project: current.name,
      }),
      group: "Create",
      icon: <SquarePenIcon />,
      keywords: localizedSearchKeywords(
        t,
        "palette.commands.new-conversation-here.keywords",
        "session, feature, chat, agent, start",
      ),
      shortcutId: "new-session",
      description: t(
        "palette.commands.new-conversation-here.description",
        "Starts right away with the project's usual worktree setting.",
      ),
      run: () => context.createConversation(current.id),
    });
  }
  commands.push({
    id: "new-conversation",
    title: t("palette.commands.new-conversation.title", "New conversation…"),
    group: "Create",
    icon: <MessageSquarePlusIcon />,
    keywords: localizedSearchKeywords(
      t,
      "palette.commands.new-conversation.keywords",
      "session, feature, worktree, branch, project",
    ),
    description: t(
      "palette.commands.new-conversation.description",
      "Pick the project, then a new worktree, the project directory or an existing branch.",
    ),
    step: { kind: "new-conversation" },
  });
  if (isDesktopShell()) {
    commands.push({
      id: "add-project",
      title: t("palette.commands.add-project.title", "Add project…"),
      group: "Create",
      icon: <FolderPlusIcon />,
      keywords: localizedSearchKeywords(
        t,
        "palette.commands.add-project.keywords",
        "new project, folder, repository, open",
      ),
      description: t(
        "palette.commands.add-project.description",
        "Choose a folder to add as a project.",
      ),
      run: context.addProject,
    });
    commands.push({
      id: "install-cli",
      title: t("palette.commands.install-cli.title", "Install the cadencr command"),
      group: "Settings",
      icon: <SquareTerminalIcon />,
      keywords: localizedSearchKeywords(
        t,
        "palette.commands.install-cli.keywords",
        "cli, shell command, path, terminal, open from terminal",
      ),
      description: t(
        "palette.commands.install-cli.description",
        "Run cadencr open, add, update and serve from a terminal.",
      ),
      run: context.installCli,
    });
  }
  return commands;
}

function modeCommands(context: PaletteCommandContext, t: UiTranslator): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  if (context.activeFeatureId != null) {
    commands.push({
      id: "go-to-file",
      title: t("palette.commands.go-to-file.title", "Go to file…"),
      group: "Navigate",
      icon: <AtSignIcon />,
      keywords: localizedSearchKeywords(
        t,
        "palette.commands.go-to-file.keywords",
        "open, find file, fuzzy, quick open",
      ),
      description: t(
        "palette.commands.go-to-file.description",
        "Search this conversation's worktree by file name. Type @ anywhere to start.",
      ),
      mode: "files",
    });
  }
  commands.push(
    {
      id: "search-messages",
      title: t("palette.commands.search-messages.title", "Search messages…"),
      group: "Navigate",
      icon: <HashIcon />,
      keywords: localizedSearchKeywords(
        t,
        "palette.commands.search-messages.keywords",
        "full text, history, find, said, transcript",
      ),
      description: t(
        "palette.commands.search-messages.description",
        "Find the conversation where something was said. Type # anywhere to start.",
      ),
      mode: "messages",
    },
    {
      id: "change-theme",
      title: t("palette.commands.change-theme.title", "Change theme…"),
      group: "View",
      icon: <PaletteIcon />,
      keywords: localizedSearchKeywords(
        t,
        "palette.commands.change-theme.keywords",
        "appearance, dark, light, colors",
      ),
      description: t(
        "palette.commands.change-theme.description",
        "Preview each theme as you move through the list.",
      ),
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
  t: UiTranslator,
): PaletteCommand[] {
  return registered.filter(isPaletteShortcut).flatMap((id) => {
    const meta = PALETTE_SHORTCUT_COMMANDS[id];
    if (meta.group === "Conversation" && !inConversation) return [];
    return [shortcutCommand(id, t)];
  });
}

function shortcutCommand(id: PaletteShortcutId, t: UiTranslator): PaletteCommand {
  const meta = PALETTE_SHORTCUT_COMMANDS[id];
  return {
    id: `shortcut-${id}`,
    title: meta.title(t),
    group: meta.group,
    icon: PALETTE_SHORTCUT_ICONS[id],
    keywords: [meta.title((_key, defaultValue) => defaultValue), ...meta.keywords(t)],
    shortcutId: id,
    run: () => {
      // The handler unmounted between opening the palette and picking.
      if (!runShortcutAction(id))
        toast.error(
          translateUi("palette.shortcuts.unavailable", "{{command}} isn't available here anymore", {
            command: meta.title(translateUi).replace(/…$/, ""),
          }),
        );
    },
  };
}

export interface PaletteCommandSet {
  all: readonly PaletteCommand[];
  /** The few the empty palette offers. */
  suggestions: readonly PaletteCommand[];
}

export function usePaletteCommands(context: PaletteCommandContext): PaletteCommandSet {
  const { t } = useUiTranslation();
  const navigate = useNavigate();
  const ids = useShortcutActionStore(
    useShallow((state) => Object.keys(state.byId) as ShortcutId[]),
  );
  const actionCommands = useCustomActionPaletteStore((state) => state.commands);
  return useMemo(() => {
    const all = [
      ...createCommands(context, t),
      ...modeCommands(context, t),
      ...navigationCommands(navigate, t),
      ...shortcutCommands(ids, context.activeFeatureId != null, t),
      ...(context.activeFeatureId != null ? actionCommands : []),
      ...settingsCommands(navigate, t),
    ];
    const byId = new Map(all.map((command) => [command.id, command]));
    const suggestions = [
      byId.get("new-conversation-here") ?? byId.get("new-conversation"),
      byId.get("go-to-file"),
      byId.get("search-messages"),
      byId.get("go-agents"),
    ].filter((command): command is PaletteCommand => command !== undefined);
    return { all, suggestions };
  }, [actionCommands, context, ids, navigate, t]);
}
