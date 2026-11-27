import type { ShortcutTranslator } from "./types";

/**
 * Shortcut scopes. Each scope groups a set of related shortcuts in the
 * in-app cheatsheet and tells `useScopedShortcut` callers which surface a
 * binding belongs to.
 *
 * `as const` so each entry's literal `id` is preserved — `ShortcutScopeId`
 * is derived from the array below, keeping the union and the runtime list
 * as one source of truth.
 */
export const SHORTCUT_SCOPES = [
  {
    id: "global",
    describeLabel(t) {
      return t("shortcuts.scopes.global.label", "Global");
    },
    describeHint(t) {
      return t("shortcuts.scopes.global.hint", "Work anywhere in Cadencr.");
    },
  },
  {
    id: "settings",
    describeLabel(t) {
      return t("shortcuts.scopes.settings.label", "Settings");
    },
    describeHint(t) {
      return t("shortcuts.scopes.settings.hint", "When the settings page is open.");
    },
  },
  {
    id: "sidebar",
    describeLabel(t) {
      return t("shortcuts.scopes.sidebar.label", "Sidebar");
    },
    describeHint(t) {
      return t("shortcuts.scopes.sidebar.hint", "When the project tree has focus.");
    },
  },
  {
    id: "unified-agents",
    describeLabel(t) {
      return t("shortcuts.scopes.unified-agents.label", "Unified Agents");
    },
    describeHint(t) {
      return t("shortcuts.scopes.unified-agents.hint", "On the /agents grid view.");
    },
  },
  {
    id: "feature-panes",
    describeLabel(t) {
      return t("shortcuts.scopes.feature-panes.label", "Feature panes");
    },
    describeHint(t) {
      return t(
        "shortcuts.scopes.feature-panes.hint",
        "Inside a feature workspace — switches between Agent / Editor / Terminal / Git tabs.",
      );
    },
  },
  {
    id: "feature",
    describeLabel(t) {
      return t("shortcuts.scopes.feature.label", "Feature actions");
    },
    describeHint(t) {
      return t(
        "shortcuts.scopes.feature.hint",
        "Inside a feature workspace — header buttons and labels.",
      );
    },
  },
  {
    id: "agent",
    describeLabel(t) {
      return t("shortcuts.scopes.agent.label", "Agent & prompt");
    },
    describeHint(t) {
      return t("shortcuts.scopes.agent.hint", "When the Agent tab is focused.");
    },
  },
  {
    id: "plan-approval",
    describeLabel(t) {
      return t("shortcuts.scopes.plan-approval.label", "Plan approval");
    },
    describeHint(t) {
      return t("shortcuts.scopes.plan-approval.hint", "While a plan-approval bar is showing.");
    },
  },
  {
    id: "permission-prompt",
    describeLabel(t) {
      return t("shortcuts.scopes.permission-prompt.label", "Tool permission");
    },
    describeHint(t) {
      return t(
        "shortcuts.scopes.permission-prompt.hint",
        "While the agent is asking permission to run a tool.",
      );
    },
  },
  {
    id: "question-drawer",
    describeLabel(t) {
      return t("shortcuts.scopes.question-drawer.label", "Agent questions");
    },
    describeHint(t) {
      return t(
        "shortcuts.scopes.question-drawer.hint",
        "While the agent is asking a multiple-choice question.",
      );
    },
  },
  {
    id: "diff-viewer",
    describeLabel(t) {
      return t("shortcuts.scopes.diff-viewer.label", "Git tab");
    },
    describeHint(t) {
      return t("shortcuts.scopes.diff-viewer.hint", "When the Git tab is focused.");
    },
  },
  {
    id: "editor",
    describeLabel(t) {
      return t("shortcuts.scopes.editor.label", "Editor");
    },
    describeHint(t) {
      return t("shortcuts.scopes.editor.hint", "When the Editor tab has focus.");
    },
  },
  {
    id: "editor-buffer",
    describeLabel(t) {
      return t("shortcuts.scopes.editor-buffer.label", "Editor buffer");
    },
    describeHint(t) {
      return t(
        "shortcuts.scopes.editor-buffer.hint",
        "When text focus is inside a CodeMirror file buffer.",
      );
    },
  },
  {
    id: "terminal",
    describeLabel(t) {
      return t("shortcuts.scopes.terminal.label", "Terminal");
    },
    describeHint(t) {
      return t("shortcuts.scopes.terminal.hint", "When the Terminal tab has focus.");
    },
  },
  {
    id: "browser",
    describeLabel(t) {
      return t("shortcuts.scopes.browser.label", "Browser");
    },
    describeHint(t) {
      return t("shortcuts.scopes.browser.hint", "When the Browser tab has focus.");
    },
  },
  {
    id: "command-palette",
    describeLabel(t) {
      return t("shortcuts.scopes.command-palette.label", "Command palette");
    },
    describeHint(t) {
      return t("shortcuts.scopes.command-palette.hint", "While the command palette is open.");
    },
  },
  {
    id: "model-picker",
    describeLabel(t) {
      return t("shortcuts.scopes.model-picker.label", "Model picker");
    },
    describeHint(t) {
      return t("shortcuts.scopes.model-picker.hint", "While a model picker popover is open.");
    },
  },
] as const satisfies readonly {
  id: string;
  describeLabel: (t: ShortcutTranslator) => string;
  describeHint: (t: ShortcutTranslator) => string;
}[];

export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number];
export type ShortcutScopeId = ShortcutScope["id"];
