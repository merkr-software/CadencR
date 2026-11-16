import { isManagedThemeId, type ThemeDefinition, type ThemeId } from "./types";

/**
 * Runtime registry of user-authored themes.
 *
 * User themes arrive from `GET /api/themes` (the renderer never touches the
 * filesystem — the backend may be remote), so unlike the built-ins they are not
 * known at module load. This module holds the resolved definitions and mirrors
 * them into localStorage so `main.tsx` can apply the active one *pre-paint*,
 * before React mounts and the fetch resolves — the same paint-hint trick
 * `readPersistedTheme` uses for the theme id itself.
 *
 * Only themes that passed backend validation are ever registered here; an
 * invalid theme is surfaced in the gallery and never applied.
 */

const CACHE_KEY = "cadencr.theme.user";

let version = 0;
// Seeded from the cache so the first registration after the fetch settles is a
// true no-op when nothing changed — the overwhelmingly common case, including
// "no user themes at all". Starting this at `null` made every cold start bump
// the version and re-render every `useTheme()` consumer in the app.
let lastSerialized = readCache() ?? "[]";
let userThemes: ReadonlyMap<ThemeId, ThemeDefinition> = hydrateFromCache();
const listeners = new Set<() => void>();

/**
 * External-store subscription so React re-renders when themes are registered.
 * Without it, a `user:` id stays unresolvable until some unrelated render
 * happens to run — and a live file edit would update the registry and repaint
 * nothing.
 */
export function subscribeUserThemes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUserThemesVersion(): number {
  return version;
}

/** The cached payload, or `null` when absent, unreadable or corrupt. */
function readCache(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? raw : null;
  } catch {
    // A corrupt or unreadable cache is a cold start, not an error: the fetch
    // that follows re-registers every theme a moment later.
    return null;
  }
}

function hydrateFromCache(): ReadonlyMap<ThemeId, ThemeDefinition> {
  const raw = readCache();
  return raw ? toMap(JSON.parse(raw) as ThemeDefinition[]) : new Map();
}

function toMap(themes: ThemeDefinition[]): ReadonlyMap<ThemeId, ThemeDefinition> {
  return new Map(themes.map((theme) => [theme.id, theme]));
}

/**
 * Replace the registry with the themes the backend reports as valid.
 *
 * No-ops when nothing changed. The caller re-runs on every `GET /api/themes`
 * settle, and notifying unconditionally would re-apply the theme (and so
 * rewrite the injected stylesheet) on every refetch.
 */
export function setUserThemes(themes: ThemeDefinition[]): void {
  replaceThemes([...themes, ...listUserThemes().filter((theme) => isManagedThemeId(theme.id))]);
}

/** Managed revisions are refreshed separately and never become editable author themes. */
export function setManagedThemes(themes: ThemeDefinition[]): void {
  replaceThemes([...listUserThemes().filter((theme) => !isManagedThemeId(theme.id)), ...themes]);
}

function replaceThemes(themes: ThemeDefinition[]): void {
  const serialized = JSON.stringify(themes);
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  userThemes = toMap(themes);
  version += 1;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CACHE_KEY, serialized);
    } catch {
      // localStorage can throw when full or sandboxed. The registry is still
      // correct for this session; only the next cold start loses the paint hint.
    }
  }
  for (const listener of listeners) listener();
}

export function getUserTheme(id: string): ThemeDefinition | undefined {
  return userThemes.get(id as ThemeId);
}

export function listUserThemes(): ThemeDefinition[] {
  return [...userThemes.values()];
}
