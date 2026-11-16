/**
 * Single source of truth for every user-visible keyboard shortcut.
 *
 * The registry is split across three sibling files for size and clarity —
 * this module re-exports the public surface, derives the indexed view used
 * by the in-app cheatsheet modal, and runs a dev-only duplicate-id check.
 *
 * - {@link ./scopes}  – `SHORTCUT_SCOPES` and scope types.
 * - {@link ./types}   – `Shortcut`, `ShortcutKey`.
 * - {@link ./entries} – `SHORTCUTS` array and the derived `ShortcutId` union.
 *
 * Add new shortcuts to `entries.ts`; add new scopes to `scopes.ts`. The
 * in-app Keyboard Shortcuts modal (⌘⇧?) renders straight from this list,
 * so anything missing there is effectively undocumented.
 */
import { SHORTCUT_SCOPES, type ShortcutScope } from "./scopes";
import { SHORTCUTS } from "./entries";
import type { Shortcut } from "./types";

export { SHORTCUT_SCOPES, SHORTCUTS };
export type { Shortcut, ShortcutKey } from "./types";
export type { ShortcutScope, ShortcutScopeId } from "./scopes";
export type { ShortcutId } from "./entries";

/**
 * Duplicate-id check. Combo collisions within a scope are tolerated when
 * they're deliberate state-dependent dual purposes, but two entries sharing
 * an `id` would make the resolver pick whichever appears first. Dev-only so a bad PR
 * fails CI rather than shipping silent ambiguity; tree-shaken in prod.
 */
if (import.meta.env.DEV) {
  const seen = new Set<string>();
  for (const s of SHORTCUTS) {
    if (seen.has(s.id)) {
      throw new Error(`Duplicate shortcut id "${s.id}" in lib/shortcuts/entries.ts`);
    }
    seen.add(s.id);
  }
}

/** Indexed view used by the modal — computed once at module load since the
 *  underlying registry is static. */
export const SHORTCUTS_BY_SCOPE: ReadonlyArray<{ scope: ShortcutScope; items: Shortcut[] }> =
  SHORTCUT_SCOPES.map((scope) => ({
    scope,
    items: SHORTCUTS.filter((s) => s.scope === scope.id),
  })).filter((g) => g.items.length > 0);
