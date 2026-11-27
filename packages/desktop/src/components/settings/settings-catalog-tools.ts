import { Code2, GitMerge, Globe, Puzzle, Play } from "lucide-react";
import { FORGE_SETTINGS_ANCHOR } from "@/lib/settings-anchors";
import { SETTINGS_ANCHORS as A } from "./settings-anchor-ids";
import {
  settingsIcon,
  settingsKeywords,
  settingsLabel,
  type SettingsNavGroup,
  type SettingsPageMeta,
  type SettingsTranslator,
} from "./settings-catalog-types";

export function toolsSettings(t: SettingsTranslator): SettingsNavGroup {
  return {
    ...settingsLabel(t, "settings.nav.groups.tools", "Tools"),
    pages: [editorPage(t), gitPage(t), browserPage(t), customTabsPage(t), actionsPage(t)],
  };
}

function editorPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "editor",
    label: "Editor",
    icon: settingsIcon(Code2),
    description: "The built-in code editor, its language servers and the file tree.",
    entries: [
      {
        ...settingsLabel(t, "settings.nav.editor.entries.vim-mode.label", "Vim mode"),
        anchor: A.editing,
        keywords: settingsKeywords(
          t,
          "settings.nav.editor.entries.vim-mode.keywords",
          "neovim, vim motions",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.editor.entries.auto-save.label", "Auto-save"),
        anchor: A.editing,
      },
      {
        ...settingsLabel(t, "settings.nav.editor.entries.git-blame.label", "Git blame"),
        anchor: A.editing,
        keywords: settingsKeywords(
          t,
          "settings.nav.editor.entries.git-blame.keywords",
          "annotation",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.editor.entries.max-open-tabs.label", "Max open tabs"),
        anchor: A.editing,
        keywords: settingsKeywords(
          t,
          "settings.nav.editor.entries.max-open-tabs.keywords",
          "tab limit",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.editor.entries.language-servers.label",
          "Language servers",
        ),
        anchor: A.lsp,
        keywords: settingsKeywords(
          t,
          "settings.nav.editor.entries.language-servers.keywords",
          "lsp, go to definition",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.editor.entries.file-tree-icons.label", "File tree icons"),
        anchor: A.fileTree,
        keywords: settingsKeywords(
          t,
          "settings.nav.editor.entries.file-tree-icons.keywords",
          "icon theme",
        ),
      },
    ],
  };
}

function gitPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "git",
    label: "Git",
    icon: settingsIcon(GitMerge),
    description: "Merging, diffs, and the hosts behind your remotes.",
    entries: [
      {
        ...settingsLabel(t, "settings.nav.git.entries.merge-strategy.label", "Merge strategy"),
        anchor: A.merge,
        keywords: settingsKeywords(
          t,
          "settings.nav.git.entries.merge-strategy.keywords",
          "squash, rebase, no-ff",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.git.entries.diff-layout.label", "Diff layout"),
        anchor: A.diff,
        keywords: settingsKeywords(
          t,
          "settings.nav.git.entries.diff-layout.keywords",
          "split, unified",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.git.entries.remote-connections.label",
          "Remote connections",
        ),
        anchor: FORGE_SETTINGS_ANCHOR,
        keywords: settingsKeywords(
          t,
          "settings.nav.git.entries.remote-connections.keywords",
          "github, gitlab, bitbucket, pull request, token, forge",
        ),
      },
    ],
  };
}

function browserPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "browser",
    label: "Browser",
    icon: settingsIcon(Globe),
    description:
      "The Browser tab: when it opens beside the agent, which cookies it keeps, how it searches, and which links it catches.",
    entries: [
      {
        ...settingsLabel(t, "settings.nav.browser.entries.auto-layout.label", "Auto layout"),
        anchor: A.browserLayout,
        keywords: settingsKeywords(
          t,
          "settings.nav.browser.entries.auto-layout.keywords",
          "split, reveal",
        ),
        requires: "wide-screen",
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.browser.entries.default-browser-mode.label",
          "Default browser mode",
        ),
        anchor: A.browserMode,
        keywords: settingsKeywords(
          t,
          "settings.nav.browser.entries.default-browser-mode.keywords",
          "private, cookies",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.browser.entries.search-engine.label", "Search engine"),
        anchor: A.browserSearch,
        keywords: settingsKeywords(
          t,
          "settings.nav.browser.entries.search-engine.keywords",
          "google, duckduckgo",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.browser.entries.open-in-cadencr-s-browser.label",
          "Open in Cadencr's browser",
        ),
        anchor: A.browserDomains,
        keywords: settingsKeywords(
          t,
          "settings.nav.browser.entries.open-in-cadencr-s-browser.keywords",
          "domains, links",
        ),
      },
    ],
  };
}

function customTabsPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "custom-tabs",
    label: "Custom tabs",
    icon: settingsIcon(Puzzle),
    description:
      "Web apps you build that open as tabs in a conversation, next to Agent, Terminal and Git. Each one only sees what you allow. Desktop only.",
    entries: [
      {
        ...settingsLabel(
          t,
          "settings.nav.custom-tabs.entries.create-custom-tab.label",
          "Create custom tab",
        ),
        keywords: settingsKeywords(
          t,
          "settings.nav.custom-tabs.entries.create-custom-tab.keywords",
          "plugin, extension",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.custom-tabs.entries.replace-built-in-tabs.label",
          "Replace built-in tabs",
        ),
        anchor: A.tabReplacements,
        keywords: settingsKeywords(
          t,
          "settings.nav.custom-tabs.entries.replace-built-in-tabs.keywords",
          "replace, override, git, terminal, editor, preview",
        ),
      },
    ],
  };
}

function actionsPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "actions",
    label: "Custom actions",
    icon: settingsIcon(Play),
    description:
      "Commands you run often in a conversation's working copy: tests, linters, deploys, dev servers.",
    entries: [
      {
        ...settingsLabel(t, "settings.nav.actions.entries.custom-actions.label", "Custom actions"),
        keywords: settingsKeywords(
          t,
          "settings.nav.actions.entries.custom-actions.keywords",
          "scripts, run, commands",
        ),
      },
    ],
  };
}
