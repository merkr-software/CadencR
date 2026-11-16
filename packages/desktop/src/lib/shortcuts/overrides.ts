/**
 * Per-shortcut override layer. The id-based hooks read every binding
 * through this module, so swapping out the storage backend (in-memory
 * today, workspace setting tomorrow, per-user preference later) is a
 * single-file change that doesn't touch the ~70 call sites.
 *
 * Today the overrides live in a Zustand store with no persistence. That
 * is deliberate — the customization UI doesn't ship in this pass. The
 * shape (`Record<id, { keys, altKeys? }>`) is the same one we'd serialize
 * to JSON when persistence lands, so the migration is mechanical.
 */
import { create } from "zustand";

import { getRegistryShortcut } from "./resolve";
import type { ShortcutId, ShortcutKey } from "./registry";

const LEGACY_OVERRIDE_IDS: Partial<Record<ShortcutId, readonly string[]>> = {
  "git-next-item": ["diff-next-file"],
  "git-previous-item": ["diff-prev-file"],
  "git-open-item": ["diff-toggle-file"],
  "git-scroll-down": ["diff-scroll-down"],
  "git-scroll-up": ["diff-scroll-up"],
  "git-toggle-viewed": ["diff-mark-viewed"],
  "git-open-in-editor": ["diff-open-focused-file"],
};

export interface ShortcutOverride {
  keys: ShortcutKey[];
  altKeys?: ShortcutKey[];
}

interface ShortcutOverridesState {
  overrides: Record<string, ShortcutOverride>;
  setOverride: (id: ShortcutId, override: ShortcutOverride) => void;
  clearOverride: (id: ShortcutId) => void;
  resetAll: () => void;
}

export const useShortcutOverridesStore = create<ShortcutOverridesState>((set) => ({
  overrides: {},
  setOverride: (id, override) =>
    set((s) => {
      const next = { ...s.overrides, [id]: override };
      for (const legacyId of LEGACY_OVERRIDE_IDS[id] ?? []) delete next[legacyId];
      return { overrides: next };
    }),
  clearOverride: (id) =>
    set((s) => {
      const next = { ...s.overrides };
      delete next[id];
      for (const legacyId of LEGACY_OVERRIDE_IDS[id] ?? []) delete next[legacyId];
      if (Object.keys(next).length === Object.keys(s.overrides).length) return s;
      return { overrides: next };
    }),
  resetAll: () => set({ overrides: {} }),
}));

/**
 * Effective binding for an id — override if present, registry default
 * otherwise. Subscribes to just the override slot at `overrides[id]`, so
 * editing one shortcut never re-renders the consumers of every other one.
 *
 * Returned value reuses the registry object's reference when no override
 * exists, so `useEffect` keyed on this stays stable across renders.
 */
export function useResolvedShortcut(id: ShortcutId): {
  keys: ShortcutKey[];
  altKeys?: ShortcutKey[];
} {
  const override = useShortcutOverridesStore((s) => findOverride(s.overrides, id));
  return override ?? getRegistryShortcut(id);
}

/** The user's binding for `id`, under its current or a legacy id. */
export function findOverride(
  overrides: Readonly<Record<string, ShortcutOverride>>,
  id: ShortcutId,
): ShortcutOverride | undefined {
  const current = overrides[id];
  if (current) return current;
  for (const legacyId of LEGACY_OVERRIDE_IDS[id] ?? []) {
    const legacy = overrides[legacyId];
    if (legacy) return legacy;
  }
  return undefined;
}
