import { useCallback, useMemo } from "react";
import { useSettingDraft } from "@/hooks/useSettingDraft";
import {
  DEFAULT_HALO_OVERRIDE,
  overrideFor,
  parseHaloOverrides,
  THEME_HALO_OVERRIDES_SETTING_KEY,
  withOverride,
  type HaloOverride,
  type HaloOverrideMap,
  type ThemeId,
} from "@/lib/themes";

export interface UseHaloOverrideResult {
  /** The active theme's tuning, or the default when it has none. */
  override: HaloOverride;
  /** Replace it. Writing the default back removes the theme's entry. */
  setOverride: (next: HaloOverride) => void;
  /** Back to the theme's own field. */
  reset: () => void;
  /** Why the stored setting could not be read, when it could not. */
  error: string | null;
  isLoading: boolean;
  isSaving: boolean;
}

/**
 * The halo tuning for one theme, persisted as a single workspace setting.
 *
 * One setting holds every theme's entry, keyed by id, rather than one key per
 * theme: the set of themes is open (built-ins, `user:`, `managed:`), and a key
 * per theme would leave the settings table accumulating rows for themes the
 * user has since deleted.
 *
 * The sliders are a continuous edit, so this reads through `useSettingDraft`:
 * the draft is what the panel shows while a drag is in flight, and the
 * confirmed value is what the backend holds. Reading the draft first is what
 * keeps a drag live — the halos follow the pointer, and the write goes out once
 * the drag pauses.
 */
export function useHaloOverride(themeId: ThemeId): UseHaloOverrideResult {
  const setting = useSettingDraft(THEME_HALO_OVERRIDES_SETTING_KEY, 150);
  const raw = setting.draft ?? setting.value;

  // Parsed off the raw string, not off a settings map: the map is rebuilt on
  // every unrelated settings write, and a fresh override object each time would
  // re-render every halo layer behind the app.
  const parsed = useMemo(() => parseHaloOverrides(raw), [raw]);
  const overrides = useMemo<HaloOverrideMap>(() => parsed.value ?? {}, [parsed]);
  const override = useMemo(() => overrideFor(overrides, themeId), [overrides, themeId]);

  const { setDraft } = setting;
  const setOverride = useCallback(
    (next: HaloOverride): void => {
      // Built from the draft, so a drag that has not been persisted yet is the
      // base of the next step instead of being reverted by it.
      setDraft(JSON.stringify(withOverride(overrides, themeId, next)));
    },
    [overrides, setDraft, themeId],
  );

  const reset = useCallback((): void => {
    setOverride(DEFAULT_HALO_OVERRIDE);
  }, [setOverride]);

  return useMemo(
    () => ({
      override,
      setOverride,
      reset,
      error: parsed.error,
      isLoading: setting.isLoading,
      isSaving: setting.isSaving,
    }),
    [override, setOverride, reset, parsed.error, setting.isLoading, setting.isSaving],
  );
}
