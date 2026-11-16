/**
 * Keyboard shortcuts around a focused custom tab (docs/CUSTOM_TABS.md §5.1).
 *
 * A guest view swallows the keys typed into it before the renderer sees
 * them, so the main process matches each key itself: Cadencr's shortcuts
 * first — every one that works anywhere in a conversation — then the tab's
 * own (`tab.json` `shortcuts`). A tab shortcut on the same keys as a Cadencr
 * one is left out, so it can never take a key Cadencr uses.
 */
import type { TabShortcut } from "@/api/generated";
import { findOverride, type ShortcutOverride } from "@/lib/shortcuts/overrides";
import { SHORTCUTS, type ShortcutKey, type ShortcutScopeId } from "@/lib/shortcuts/registry";
import type { PluginTabShortcutBinding } from "@/shared/plugin-tab-host";

/** The scopes whose shortcuts apply while a custom tab has focus. */
const SCOPES_OVER_A_TAB: ReadonlySet<ShortcutScopeId> = new Set([
  "global",
  "feature",
  "feature-panes",
]);
/** Handled by the application menu, whose accelerator a guest never blocks. */
const MENU_SHORTCUTS: ReadonlySet<string> = new Set(["quit"]);
/** One of these must be held; a bare key belongs to whatever the tab is typing into. */
const COMMAND_MODIFIERS: ReadonlySet<string> = new Set(["mod", "ctrl", "alt"]);

/** A Cadencr shortcut a focused tab gives way to. */
export interface AppShortcutBinding extends PluginTabShortcutBinding {
  id: string;
  description: string;
}

function isCommandChord(keys: readonly ShortcutKey[]): boolean {
  return keys.some((key) => COMMAND_MODIFIERS.has(key));
}

/**
 * Cadencr's shortcuts a focused tab gives way to, as currently bound
 * (`overrides` first, else the registry).
 */
export function appShortcutBindings(
  overrides: Readonly<Record<string, ShortcutOverride>>,
): AppShortcutBinding[] {
  const bindings: AppShortcutBinding[] = [];
  for (const shortcut of SHORTCUTS) {
    if (!SCOPES_OVER_A_TAB.has(shortcut.scope) || MENU_SHORTCUTS.has(shortcut.id)) continue;
    const bound: ShortcutOverride = findOverride(overrides, shortcut.id) ?? shortcut;
    const combos = [bound.keys, bound.altKeys].filter(
      (keys): keys is ShortcutKey[] =>
        keys !== undefined && keys.length > 0 && isCommandChord(keys),
    );
    const [keys, altKeys] = combos;
    if (!keys) continue;
    bindings.push({
      id: shortcut.id,
      description: shortcut.description,
      keys,
      ...(altKeys ? { altKeys } : {}),
    });
  }
  return bindings;
}

/**
 * One comparable spelling of a chord: `mod` as the key it is on this
 * platform, `question` as Shift+/, modifiers sorted. Token-level: the main
 * process still matches Cadencr's shortcuts first, so a chord two spellings
 * share on some layout only goes to Cadencr.
 */
export function chordKey(keys: readonly string[], isMac: boolean): string {
  const modifiers = new Set<string>();
  let key = "";
  for (const token of keys) {
    if (token === "mod") modifiers.add(isMac ? "meta" : "ctrl");
    else if (token === "ctrl" || token === "alt" || token === "shift") modifiers.add(token);
    else if (token === "question") {
      modifiers.add("shift");
      key = "slash";
    } else key = token.toLowerCase();
  }
  return [...[...modifiers].sort(), key].join("+");
}

/** A declared tab shortcut and the Cadencr shortcut that takes its keys, if any. */
export interface ResolvedTabShortcut {
  shortcut: TabShortcut;
  /** The Cadencr shortcut on the same keys: this one never fires. */
  takenBy: AppShortcutBinding | null;
}

/** Each declared shortcut of a tab, with the Cadencr shortcut it collides with. */
export function resolveTabShortcuts(
  shortcuts: readonly TabShortcut[],
  app: readonly AppShortcutBinding[],
  isMac: boolean,
): ResolvedTabShortcut[] {
  const taken = new Map<string, AppShortcutBinding>();
  for (const binding of app) {
    for (const keys of [binding.keys, binding.altKeys]) {
      if (keys) taken.set(chordKey(keys, isMac), binding);
    }
  }
  return shortcuts.map((shortcut) => ({
    shortcut,
    takenBy: taken.get(chordKey(shortcut.keys, isMac)) ?? null,
  }));
}

/** A tab's shortcuts that can fire. */
export function activeShortcuts(resolved: readonly ResolvedTabShortcut[]): TabShortcut[] {
  return resolved.filter(({ takenBy }) => !takenBy).map(({ shortcut }) => shortcut);
}
