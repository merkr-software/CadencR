import { SlidersHorizontal, Palette, PanelLeft, Bell } from "lucide-react";
import { SETTINGS_ANCHORS as A } from "./settings-anchor-ids";
import {
  settingsIcon,
  settingsKeywords,
  settingsLabel,
  type SettingsNavGroup,
  type SettingsPageMeta,
  type SettingsTranslator,
} from "./settings-catalog-types";

export function preferencesSettings(t: SettingsTranslator): SettingsNavGroup {
  return {
    ...settingsLabel(t, "settings.nav.groups.preferences", "Preferences"),
    pages: [generalPage(t), appearancePage(t), sidebarPage(t), notificationsPage(t)],
  };
}

function generalPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "general",
    label: "General",
    icon: settingsIcon(SlidersHorizontal),
    description:
      "Interface scale, keyboard shortcuts, restarts, the cadencr command and the file every setting is saved in.",
    aliases: ["interface"],
    entries: [
      ...(import.meta.env.DEV
        ? [
            {
              ...settingsLabel(t, "settings.nav.general.entries.language.label", "Language"),
              anchor: A.interface,
              keywords: settingsKeywords(
                t,
                "settings.nav.general.entries.language.keywords",
                "langue, locale",
              ),
            },
          ]
        : []),
      {
        ...settingsLabel(t, "settings.nav.general.entries.ui-zoom.label", "UI zoom"),
        anchor: A.interface,
        keywords: settingsKeywords(
          t,
          "settings.nav.general.entries.ui-zoom.keywords",
          "scale, zoom, font size",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.general.entries.keyboard-shortcuts.label",
          "Keyboard shortcuts",
        ),
        anchor: A.keyboard,
        keywords: settingsKeywords(
          t,
          "settings.nav.general.entries.keyboard-shortcuts.keywords",
          "hotkeys, keybindings",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.general.entries.resume-agents-after-a-restart.label",
          "Resume agents after a restart",
        ),
        anchor: A.restarts,
        keywords: settingsKeywords(
          t,
          "settings.nav.general.entries.resume-agents-after-a-restart.keywords",
          "update, crash, continue",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.general.entries.command-line.label", "Command line"),
        anchor: A.commandLine,
        keywords: settingsKeywords(
          t,
          "settings.nav.general.entries.command-line.keywords",
          "cadencr, cli, terminal, shell command, path, install",
        ),
        requires: "desktop-shell",
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.general.entries.configuration-file.label",
          "Configuration file",
        ),
        anchor: A.settingsFile,
        keywords: settingsKeywords(
          t,
          "settings.nav.general.entries.configuration-file.keywords",
          "settings.json, json, edit, path",
        ),
      },
    ],
  };
}

function appearancePage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "appearance",
    label: "Appearance",
    icon: settingsIcon(Palette),
    description: "Theme, motion, the typeface used for code and how agent transcripts read.",
    entries: [
      {
        ...settingsLabel(t, "settings.nav.appearance.entries.theme.label", "Theme"),
        anchor: A.theme,
        keywords: settingsKeywords(
          t,
          "settings.nav.appearance.entries.theme.keywords",
          "dark, light, colors",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.appearance.entries.fluid-animations.label",
          "Fluid animations",
        ),
        anchor: A.theme,
        keywords: settingsKeywords(
          t,
          "settings.nav.appearance.entries.fluid-animations.keywords",
          "motion, reduced motion",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.appearance.entries.monospace-font.label",
          "Monospace font",
        ),
        anchor: A.font,
        keywords: settingsKeywords(
          t,
          "settings.nav.appearance.entries.monospace-font.keywords",
          "typeface, code font",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.appearance.entries.theme-library.label", "Theme library"),
        anchor: A.themeLibrary,
        keywords: settingsKeywords(
          t,
          "settings.nav.appearance.entries.theme-library.keywords",
          "custom theme, create",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.appearance.entries.agent-output-verbosity.label",
          "Agent output verbosity",
        ),
        anchor: A.agentOutput,
        keywords: settingsKeywords(
          t,
          "settings.nav.appearance.entries.agent-output-verbosity.keywords",
          "maximal, minimal, compact, transcript, tool calls",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.appearance.entries.summary-mode.label", "Summary mode"),
        anchor: A.agentOutput,
        keywords: settingsKeywords(
          t,
          "settings.nav.appearance.entries.summary-mode.keywords",
          "recap",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.appearance.entries.message-navigator.label",
          "Message navigator",
        ),
        anchor: A.agentOutput,
        keywords: settingsKeywords(
          t,
          "settings.nav.appearance.entries.message-navigator.keywords",
          "ticks, jump",
        ),
      },
    ],
  };
}

function sidebarPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "sidebar",
    label: "Sidebar",
    icon: settingsIcon(PanelLeft),
    description:
      "How conversations are listed. The sliders button in the sidebar's Projects header edits the same options; changes apply at once and follow you to remote devices. Point at an option to see what it changes in the preview.",
    wide: true,
    aliases: ["sidebar-display"],
    entries: [
      {
        ...settingsLabel(
          t,
          "settings.nav.sidebar.entries.sidebar-presets.label",
          "Sidebar presets",
        ),
        keywords: settingsKeywords(
          t,
          "settings.nav.sidebar.entries.sidebar-presets.keywords",
          "classic, focus, supervise, detailed",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.sidebar.entries.density.label", "Density"),
        keywords: settingsKeywords(
          t,
          "settings.nav.sidebar.entries.density.keywords",
          "compact, row height, text size",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.sidebar.entries.block-order.label", "Block order"),
        keywords: settingsKeywords(
          t,
          "settings.nav.sidebar.entries.block-order.keywords",
          "pinned, for me, recent",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.sidebar.entries.collapsed-rail.label", "Collapsed rail"),
        keywords: settingsKeywords(
          t,
          "settings.nav.sidebar.entries.collapsed-rail.keywords",
          "rail, collapse",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.sidebar.entries.saved-views.label", "Saved views"),
        anchor: A.sidebarViews,
        keywords: settingsKeywords(
          t,
          "settings.nav.sidebar.entries.saved-views.keywords",
          "query, filter, lens",
        ),
      },
    ],
  };
}

function notificationsPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "notifications",
    label: "Notifications",
    icon: settingsIcon(Bell),
    description: "Where Cadencr tells you an agent finished or needs you.",
    entries: [
      {
        ...settingsLabel(
          t,
          "settings.nav.notifications.entries.notification-destination.label",
          "Notification destination",
        ),
        anchor: A.notificationDestination,
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.notifications.entries.push-notifications.label",
          "Push notifications",
        ),
        anchor: A.push,
        keywords: settingsKeywords(
          t,
          "settings.nav.notifications.entries.push-notifications.keywords",
          "phone, remote, pwa",
        ),
        requires: "remote-browser",
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.notifications.entries.notch-island.label",
          "Notch island",
        ),
        anchor: A.notch,
        keywords: settingsKeywords(
          t,
          "settings.nav.notifications.entries.notch-island.keywords",
          "macos, display, island",
        ),
        requires: "macos-desktop",
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.notifications.entries.send-test-notification.label",
          "Send test notification",
        ),
        anchor: A.notificationTest,
        keywords: settingsKeywords(
          t,
          "settings.nav.notifications.entries.send-test-notification.keywords",
          "debug",
        ),
        requires: "desktop-shell",
      },
    ],
  };
}
