/**
 * Canonical shortcut list. Each entry mirrors a real `useHotkeys` /
 * `useScopedHotkeys` / `useGlobalShortcut` registration somewhere in the
 * codebase. If you add a new shortcut, add it here too — the in-app
 * Keyboard Shortcuts modal (⌘⇧?) renders straight from this list, so
 * anything missing here is effectively undocumented.
 *
 * `keys` is the platform-agnostic combo. Use the literal tokens from
 * `ShortcutKey`; the formatter in `format.ts` turns them into ⌘/⌃/⌥/⇧ on
 * macOS or Ctrl/Alt/Shift on other platforms.
 *
 * Order within a scope is the order rendered. Editor + editor-buffer
 * entries live in {@link ./entries-editor}, sidebar entries in
 * {@link ./entries-sidebar}, to keep this file under the 400-line limit;
 * they are concatenated below.
 *
 * `as const satisfies` keeps the literal `id` of every entry so the
 * `ShortcutId` union below is derived from this single source — typos in
 * `useShortcut("comand-palette", …)` become compile errors.
 */
import { APP_SHORTCUTS } from "./entries-app";
import { AGENT_SHORTCUTS } from "./entries-agent";
import { BROWSER_SHORTCUTS } from "./entries-browser";
import { EDITOR_SHORTCUTS } from "./entries-editor";
import { GIT_SHORTCUTS } from "./entries-git";
import { MODEL_PICKER_SHORTCUTS } from "./entries-model-picker";
import { PALETTE_SHORTCUTS } from "./entries-palette";
import { SIDEBAR_SHORTCUTS } from "./entries-sidebar";
import { TERMINAL_SHORTCUTS } from "./entries-terminal";

export const SHORTCUTS = [
  ...APP_SHORTCUTS,
  ...AGENT_SHORTCUTS,
  ...SIDEBAR_SHORTCUTS,
  ...GIT_SHORTCUTS,
  ...TERMINAL_SHORTCUTS,
  ...EDITOR_SHORTCUTS,
  ...BROWSER_SHORTCUTS,
  ...MODEL_PICKER_SHORTCUTS,
  ...PALETTE_SHORTCUTS,
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];
