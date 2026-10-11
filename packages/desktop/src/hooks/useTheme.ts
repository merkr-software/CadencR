import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useDebouncedSettingFromMap } from "@/hooks/useDebouncedSetting";
import { useSystemAppearance } from "@/hooks/useSystemAppearance";
import { settingsArrayToMap, useGetWorkspaceSettings } from "@/api/settings";
import {
  applyThemeToDocument,
  getTheme,
  isFollowSystemThemeEnabled,
  parseThemeId,
  parseSystemDarkThemeId,
  parseSystemLightThemeId,
  resolveActiveThemeId,
  THEME_FOLLOW_SYSTEM_SETTING_KEY,
  THEME_SETTING_KEY,
  THEME_SYSTEM_DARK_SETTING_KEY,
  THEME_SYSTEM_LIGHT_SETTING_KEY,
  writePersistedThemeSettings,
  type ThemeDefinition,
  type ThemeId,
} from "@/lib/themes";
import { getUserThemesVersion, subscribeUserThemes } from "@/lib/themes/user-registry";
import { useUserThemeRegistry } from "@/hooks/useUserThemes";
import { useManagedThemeRegistry } from "@/hooks/useManagedThemes";

interface UseThemeResult {
  themeId: ThemeId;
  theme: ThemeDefinition;
  manualThemeId: ThemeId;
  systemLightThemeId: ThemeId;
  systemDarkThemeId: ThemeId;
  followSystemTheme: boolean;
  setTheme: (next: ThemeId) => void;
  setSystemLightTheme: (next: ThemeId) => void;
  setSystemDarkTheme: (next: ThemeId) => void;
  setFollowSystemTheme: (next: boolean) => void;
  isLoading: boolean;
  systemAppearanceError: Error | null;
}

/**
 * Subscribe to the active theme. Persistence reuses the same
 * `/api/workspace/settings` plumbing every other setting goes through.
 *
 * Canvas-rendered xterm can't read CSS variables, so terminals receive the
 * palette as a JS object via `theme.xterm`. The rest of the UI follows
 * automatically because `useThemeSync` keeps `<html data-theme="…">` in
 * sync with this hook.
 *
 * Reads of the four theme keys (`THEME_*`) are folded into a single bulk
 * `GET /api/workspace/settings` rather than four `GET /…/settings/{key}`
 * fires. Writers warm the bulk cache on success so the next render skips
 * the round-trip.
 */
export function useTheme(): UseThemeResult {
  // User themes are registered asynchronously (see `useUserThemeRegistry`), so
  // resolving a `user:` id — and re-resolving it after a live file edit — has to
  // re-render this hook. `theme` below is the registry's own object, so its
  // identity changing is what tells `useThemeSync` to re-apply.
  useSyncExternalStore(subscribeUserThemes, getUserThemesVersion, getUserThemesVersion);
  const workspaceSettings = useGetWorkspaceSettings();
  const settingsMap = useMemo(
    () => settingsArrayToMap(workspaceSettings.data),
    [workspaceSettings.data],
  );
  const isMapLoading = workspaceSettings.isLoading;

  const manualSetting = useDebouncedSettingFromMap(
    settingsMap,
    THEME_SETTING_KEY,
    isMapLoading,
    0,
    {
      immediateCache: false,
    },
  );
  const followSetting = useDebouncedSettingFromMap(
    settingsMap,
    THEME_FOLLOW_SYSTEM_SETTING_KEY,
    isMapLoading,
    0,
    { immediateCache: false },
  );
  const lightSetting = useDebouncedSettingFromMap(
    settingsMap,
    THEME_SYSTEM_LIGHT_SETTING_KEY,
    isMapLoading,
    0,
    { immediateCache: false },
  );
  const darkSetting = useDebouncedSettingFromMap(
    settingsMap,
    THEME_SYSTEM_DARK_SETTING_KEY,
    isMapLoading,
    0,
    { immediateCache: false },
  );
  const systemAppearance = useSystemAppearance();

  const manualThemeId = parseThemeId(manualSetting.value);
  const systemLightThemeId = parseSystemLightThemeId(lightSetting.value);
  const systemDarkThemeId = parseSystemDarkThemeId(darkSetting.value);
  const followSystemTheme = isFollowSystemThemeEnabled(followSetting.value);
  const themeId = resolveActiveThemeId({
    followSystem: followSystemTheme,
    manualTheme: manualThemeId,
    systemLightTheme: systemLightThemeId,
    systemDarkTheme: systemDarkThemeId,
    systemAppearance: systemAppearance.appearance,
  });
  const theme = getTheme(themeId);

  return useMemo(
    () => ({
      themeId,
      theme,
      manualThemeId,
      systemLightThemeId,
      systemDarkThemeId,
      followSystemTheme,
      setTheme: manualSetting.setValue,
      setSystemLightTheme: lightSetting.setValue,
      setSystemDarkTheme: darkSetting.setValue,
      setFollowSystemTheme: (next: boolean): void => followSetting.setValue(String(next)),
      isLoading: isMapLoading,
      systemAppearanceError: systemAppearance.error,
    }),
    [
      themeId,
      theme,
      manualThemeId,
      systemLightThemeId,
      systemDarkThemeId,
      followSystemTheme,
      manualSetting.setValue,
      lightSetting.setValue,
      darkSetting.setValue,
      followSetting.setValue,
      isMapLoading,
      systemAppearance.error,
    ],
  );
}

/**
 * Side-effect-only hook: keeps `<html data-theme="…">` and the localStorage
 * paint hint in sync with the active theme. Mount once near the route root.
 *
 * `applyThemeToDocument` is idempotent and `parseThemeId` always resolves to
 * a valid id (default before the server answers), so the effect is safe to
 * run before `isLoading` flips — and not gating on it avoids the silent
 * "cache never refreshed" failure mode if the workspace fetch errors out.
 */
export function useThemeSync(): void {
  const theme = useTheme();
  useUserThemeRegistry();
  useManagedThemeRegistry();
  const didToastSystemThemeErrorRef = useRef(false);

  useEffect(() => {
    applyThemeToDocument(theme.themeId);
    writePersistedThemeSettings({
      followSystem: theme.followSystemTheme,
      manualTheme: theme.manualThemeId,
      systemLightTheme: theme.systemLightThemeId,
      systemDarkTheme: theme.systemDarkThemeId,
    });
    // `theme.theme` is in the deps deliberately: editing a user theme's file
    // changes its token values without changing its id, and re-applying is what
    // re-injects them.
  }, [
    theme.themeId,
    theme.theme,
    theme.followSystemTheme,
    theme.manualThemeId,
    theme.systemLightThemeId,
    theme.systemDarkThemeId,
  ]);

  useEffect(() => {
    if (
      !theme.followSystemTheme ||
      !theme.systemAppearanceError ||
      didToastSystemThemeErrorRef.current
    ) {
      return;
    }
    didToastSystemThemeErrorRef.current = true;
    toast.error(`Could not detect system theme: ${theme.systemAppearanceError.message}`);
  }, [theme.followSystemTheme, theme.systemAppearanceError]);
}
