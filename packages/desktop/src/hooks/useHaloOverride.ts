import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { useSetting } from "@/hooks/useSetting";
import { haloOverrideDraft } from "./halo-override-draft";
import {
  DEFAULT_HALO_OVERRIDE,
  overrideFor,
  parseHaloOverrides,
  THEME_HALO_OVERRIDES_SETTING_KEY,
  type HaloOverride,
  type ThemeId,
} from "@/lib/themes";

export interface UseHaloOverrideResult {
  /** The active theme's tuning, or the default when it has none. */
  override: HaloOverride;
  /** Replace it. Writing the default back removes the theme's entry. */
  setOverride: (next: HaloOverride) => void;
  /** Back to the theme's own field. */
  reset: () => void;
  /** Reload the map after a failed read. */
  retry: () => void;
  /** Why the stored setting could not be read, when it could not. */
  error: string | null;
  /** Edits require a successful read so another theme's tuning cannot be lost. */
  canEdit: boolean;
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
 * The panel and ambient renderer share a per-theme preview, kept apart from
 * confirmed settings. Writes are debounced and merge only the edited theme
 * into the latest confirmed map when the serialized writer sends the request.
 */
export function useHaloOverride(themeId: ThemeId): UseHaloOverrideResult {
  const setting = useSetting(THEME_HALO_OVERRIDES_SETTING_KEY);
  const queryClient = useQueryClient();
  const store = useMemo(() => haloOverrideDraft(queryClient), [queryClient]);
  const getDraft = useCallback(() => store.getDraft(themeId), [store, themeId]);
  const draft = useSyncExternalStore(store.subscribe, getDraft, getDraft);

  // Parsed off the raw string, not off a settings map: the map is rebuilt on
  // every unrelated settings write, and a fresh override object each time would
  // re-render every halo layer behind the app.
  const raw = setting.value;
  const canEdit = setting.isFetched && setting.error === null;
  const parsed = useMemo(() => parseHaloOverrides(raw), [raw]);
  const override = useMemo(
    () => draft ?? overrideFor(parsed.value ?? {}, themeId),
    [draft, parsed, themeId],
  );

  // Closing the drawer or switching themes still saves the last gesture.
  useEffect(() => () => store.flush(themeId), [store, themeId]);

  const setOverride = useCallback(
    (next: HaloOverride): void => {
      if (canEdit) store.setDraft(themeId, next);
    },
    [store, themeId, canEdit],
  );

  const reset = useCallback((): void => {
    setOverride(DEFAULT_HALO_OVERRIDE);
  }, [setOverride]);

  const retry = useCallback((): void => {
    void queryClient.resetQueries({
      queryKey: getGetWorkspaceSettingQueryKey(THEME_HALO_OVERRIDES_SETTING_KEY),
      exact: true,
    });
  }, [queryClient]);

  return useMemo(
    () => ({
      override,
      setOverride,
      reset,
      retry,
      error: setting.error ?? parsed.error,
      canEdit,
      isLoading: setting.isLoading,
      isSaving: setting.isSaving || draft !== null,
    }),
    [
      override,
      setOverride,
      reset,
      retry,
      setting.error,
      parsed.error,
      canEdit,
      setting.isLoading,
      setting.isSaving,
      draft,
    ],
  );
}
