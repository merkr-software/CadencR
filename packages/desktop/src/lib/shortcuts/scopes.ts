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
  { id: "global", label: "Global", hint: "Work anywhere in Cadencr." },
  { id: "settings", label: "Settings", hint: "When the settings page is open." },
  { id: "sidebar", label: "Sidebar", hint: "When the project tree has focus." },
  { id: "unified-agents", label: "Unified Agents", hint: "On the /agents grid view." },
  {
    id: "feature-panes",
    label: "Feature panes",
    hint: "Inside a feature workspace — switches between Agent / Editor / Terminal / Git tabs.",
  },
  {
    id: "feature",
    label: "Feature actions",
    hint: "Inside a feature workspace — header buttons and labels.",
  },
  { id: "agent", label: "Agent & prompt", hint: "When the Agent tab is focused." },
  { id: "plan-approval", label: "Plan approval", hint: "While a plan-approval bar is showing." },
  {
    id: "permission-prompt",
    label: "Tool permission",
    hint: "While the agent is asking permission to run a tool.",
  },
  {
    id: "question-drawer",
    label: "Agent questions",
    hint: "While the agent is asking a multiple-choice question.",
  },
  { id: "diff-viewer", label: "Git tab", hint: "When the Git tab is focused." },
  { id: "editor", label: "Editor", hint: "When the Editor tab has focus." },
  {
    id: "editor-buffer",
    label: "Editor buffer",
    hint: "When text focus is inside a CodeMirror file buffer.",
  },
  { id: "terminal", label: "Terminal", hint: "When the Terminal tab has focus." },
  { id: "browser", label: "Browser", hint: "When the Browser tab has focus." },
  {
    id: "command-palette",
    label: "Command palette",
    hint: "While the command palette is open.",
  },
  {
    id: "model-picker",
    label: "Model picker",
    hint: "While a model picker popover is open.",
  },
] as const;

export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number];
export type ShortcutScopeId = ShortcutScope["id"];
