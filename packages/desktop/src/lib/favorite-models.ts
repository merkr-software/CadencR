import { translateUi } from "@/shared/ui-i18n";
/**
 * Favorite (starred) models.
 *
 * A model is only unique within its provider, so favorites are keyed by a
 * `provider:model` composite — the same string the pickers use as their cmdk
 * item value. Favorites live in a single workspace setting holding a JSON
 * array of those keys, so every model selector in the app shares one list.
 */

export const FAVORITE_MODELS_SETTING_KEY = "favorite_models";

/** Composite identity for a model. Also the picker's cmdk item value. */
export function favoriteModelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

/**
 * Parses the persisted setting. Throws on malformed JSON so the caller can
 * surface it instead of silently resetting the user's starred list.
 */
export function parseFavoriteModels(raw: string | null): string[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      translateUi(
        "conversation.composer.favoriteModels.invalidList",
        "Expected an array of model keys",
      ),
    );
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}
