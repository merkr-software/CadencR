import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useListThemes, type UserTheme } from "@/api/generated";
import { settingsArrayToMap, useGetWorkspaceSettings } from "@/api/settings";
import { useSettingWriter } from "@/hooks/useSetting";
import {
  setUserThemes,
  THEME_SETTING_KEY,
  THEME_SYSTEM_DARK_SETTING_KEY,
  THEME_SYSTEM_LIGHT_SETTING_KEY,
  THEME_USER_DISABLED_SETTING_KEY,
  type ThemeDefinition,
} from "@/lib/themes";
import {
  findUnapplicableSelection,
  toThemeDefinitions,
  userThemeLabel,
} from "@/lib/themes/user-theme";

/**
 * The user's themes, as the gallery and the picker each need them.
 *
 * One `GET /api/themes` backs both: the gallery shows every entry (including
 * the broken ones, with their issues), the picker only the enabled and valid
 * ones. Registering the valid definitions is what lets `getTheme` — and so the
 * whole apply path — resolve a `user:` id at all.
 */

/** Throws on a malformed list so the caller can surface it rather than
 *  silently showing themes the user hid (or hiding ones they didn't). */
function parseDisabledIds(raw: string | null): string[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array of theme ids");
  return parsed.filter((id) => typeof id === "string");
}

function readableDisabledIds(raw: string | null): string[] {
  try {
    return parseDisabledIds(raw);
  } catch {
    return [];
  }
}

interface UseUserThemesResult {
  /** Every theme on disk, valid or not, in gallery order. */
  entries: UserTheme[];
  /** Definitions for the valid, enabled themes — what the picker offers. */
  enabledThemes: ThemeDefinition[];
  isLoading: boolean;
  isEnabled: (id: string) => boolean;
  setEnabled: (id: string, enabled: boolean) => void;
  /**
   * The theme ids the user has *selected*, straight from the settings file and
   * deliberately unparsed. `useTheme` resolves selections through
   * `parseThemeId`, which silently substitutes the default for an id it can't
   * apply — so it can't tell you "the theme you picked is broken", only "you're
   * on the default". This is the raw answer.
   */
  selectedThemeIds: string[];
  error: Error | null;
}

export function useUserThemes(): UseUserThemesResult {
  // `notifyOnChangeProps` matters here specifically: this hook runs in the root
  // layout, and a bare useQuery re-renders the root twice per invalidation on
  // fetchStatus transitions alone — even when the response is byte-identical.
  const query = useListThemes({
    query: { notifyOnChangeProps: ["data", "error", "isLoading"] },
  });
  const workspaceSettings = useGetWorkspaceSettings();
  const settingsMap = useMemo(
    () => settingsArrayToMap(workspaceSettings.data),
    [workspaceSettings.data],
  );
  const disabledValue = settingsMap[THEME_USER_DISABLED_SETTING_KEY] ?? null;
  const { setValue: setDisabledValue } = useSettingWriter(THEME_USER_DISABLED_SETTING_KEY);

  // Tolerate a not-yet-resolved or unexpected query shape rather than throwing
  // during render — the theme list is read from the root layout, so a bad
  // response here would take the whole app down instead of just the gallery.
  const entries = useMemo(() => (Array.isArray(query.data) ? query.data : []), [query.data]);
  const disabled = useMemo(() => {
    try {
      return { ids: new Set(parseDisabledIds(disabledValue)), error: null };
    } catch (e) {
      return { ids: new Set<string>(), error: e instanceof Error ? e : new Error(String(e)) };
    }
  }, [disabledValue]);
  const disabledIds = disabled.ids;

  const enabledThemes = useMemo(
    () => toThemeDefinitions(entries.filter((entry) => !disabledIds.has(entry.id))),
    [entries, disabledIds],
  );

  const selectedThemeIds = useMemo(
    () =>
      [THEME_SETTING_KEY, THEME_SYSTEM_LIGHT_SETTING_KEY, THEME_SYSTEM_DARK_SETTING_KEY].flatMap(
        (key) => (settingsMap[key] ? [settingsMap[key]] : []),
      ),
    [settingsMap],
  );

  const setEnabled = useCallback(
    (id: string, enabled: boolean): void => {
      // From the confirmed list as the write goes out, so quick toggles compose.
      void setDisabledValue((confirmed) => {
        // A list that can't be read was already reported; the toggle replaces it.
        const next = new Set(readableDisabledIds(confirmed ?? null));
        if (enabled) next.delete(id);
        else next.add(id);
        return JSON.stringify([...next]);
      });
    },
    [setDisabledValue],
  );

  return useMemo(
    () => ({
      entries,
      enabledThemes,
      isLoading: query.isLoading,
      isEnabled: (id: string): boolean => !disabledIds.has(id),
      setEnabled,
      selectedThemeIds,
      error: query.error ?? disabled.error,
    }),
    [
      entries,
      enabledThemes,
      query.isLoading,
      query.error,
      disabledIds,
      disabled.error,
      setEnabled,
      selectedThemeIds,
    ],
  );
}

/**
 * Side-effect-only companion to `useThemeSync`: keeps the module-level user
 * theme registry in step with the server, and re-applies the active theme
 * whenever it changes.
 *
 * That re-apply is what makes live editing work. `applyThemeToDocument` is
 * keyed on the theme *id*, which doesn't change when you edit the file — so
 * without an explicit re-apply, a saved edit would update the registry and
 * repaint nothing.
 */
export function useUserThemeRegistry(): void {
  const { entries, enabledThemes, selectedThemeIds } = useUserThemes();
  const didToastRef = useRef<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmount-scoped, deliberately: tying this to the effect below would let one
  // of its frequent re-runs cancel a toast it had already marked as fired.
  useEffect(() => () => clearTimeout(toastTimerRef.current ?? undefined), []);

  // Registering notifies the registry's subscribers, which re-renders
  // `useTheme` and lets `useThemeSync` apply/re-inject. This hook never touches
  // the document itself — one apply path, no races between the two.
  useEffect(() => {
    setUserThemes(enabledThemes);
  }, [enabledThemes]);

  // Surface a selected theme that can't be applied.
  useEffect(() => {
    const broken = findUnapplicableSelection(entries, selectedThemeIds);
    const signature = broken
      ? `${broken.id}:${broken.issues.map((i) => i.message).join("|")}`
      : null;
    if (!signature) {
      didToastRef.current = null;
      return;
    }
    if (didToastRef.current === signature) return;
    didToastRef.current = signature;
    const detail = broken?.issues[0];
    const summary = detail
      ? `${detail.token ? `${detail.token}: ` : ""}${detail.message}`
      : "unknown error";
    const name = broken ? userThemeLabel(broken) : "";
    // Deferred by a task, not fired inline: on a cold start this effect can run
    // in the same commit that mounts the toaster, and sonner drops anything
    // emitted before its `<Toaster>` subscribes — the toast would vanish, which
    // is precisely the silent revert it exists to prevent. Every effect in the
    // commit has run by the time a zero-delay timeout fires.
    toastTimerRef.current = setTimeout(() => {
      toast.error(`Theme "${name}" is not valid, so it was not applied — ${summary}`);
    }, 0);
  }, [entries, selectedThemeIds]);
}
