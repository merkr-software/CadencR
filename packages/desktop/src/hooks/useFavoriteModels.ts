import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useSettingWriter } from "./useSetting";
import { settingsArrayToMap, useGetWorkspaceSettings } from "@/api/settings";
import { FAVORITE_MODELS_SETTING_KEY, parseFavoriteModels } from "@/lib/favorite-models";

export interface FavoriteModelsResult {
  /** `provider:model` keys the user has starred. */
  favorites: ReadonlySet<string>;
  toggleFavorite: (key: string) => void;
}

/**
 * Starred models, shared by every model selector. Reads from the bulk
 * workspace-settings query the app already keeps resident rather than firing
 * its own per-key GET. A star changes once the backend confirms it.
 */
export function useFavoriteModels(): FavoriteModelsResult {
  const { data } = useGetWorkspaceSettings();
  const value = useMemo(
    () => settingsArrayToMap(data)[FAVORITE_MODELS_SETTING_KEY] ?? null,
    [data],
  );
  const { setValue } = useSettingWriter(FAVORITE_MODELS_SETTING_KEY);

  const parsed = useMemo(() => {
    try {
      return { favorites: new Set(parseFavoriteModels(value)), error: null };
    } catch (err) {
      return {
        favorites: new Set<string>(),
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }, [value]);

  useEffect(() => {
    if (!parsed.error) return;
    // Every mounted picker runs this hook; a shared toast id collapses the
    // duplicates into one message.
    toast.error(`Could not read your starred models: ${parsed.error}`, {
      id: FAVORITE_MODELS_SETTING_KEY,
    });
  }, [parsed.error]);

  const { favorites } = parsed;

  const toggleFavorite = useCallback(
    (key: string) => {
      // From the confirmed list as the write goes out, so quick toggles compose.
      void setValue((confirmed) => {
        // A list that can't be read was already reported; the toggle replaces it.
        const next = new Set(readableFavorites(confirmed ?? null));
        if (!next.delete(key)) next.add(key);
        return JSON.stringify([...next]);
      });
    },
    [setValue],
  );

  return useMemo(() => ({ favorites, toggleFavorite }), [favorites, toggleFavorite]);
}

function readableFavorites(raw: string | null): string[] {
  try {
    return parseFavoriteModels(raw);
  } catch {
    return [];
  }
}
