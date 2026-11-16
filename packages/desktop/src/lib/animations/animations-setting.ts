import { useSetting } from "@/hooks/useSetting";
import { useSystemReducedMotion } from "./useSystemReducedMotion";

/**
 * Workspace setting that persists the user's preference for UI animations.
 * Stored as the literal strings `"true"` / `"false"`. A missing value means
 * "use the OS default" — the frontend falls back to `prefers-reduced-motion`.
 *
 * Mirrors `animations_enabled` in
 * `packages/service/src/domain/settings_allowlist.rs`.
 */
export const ANIMATIONS_ENABLED_SETTING_KEY = "animations_enabled";

export type AnimationsPreference = "on" | "off" | "system";

export function parseAnimationsPreference(value: string | null): AnimationsPreference {
  if (value === "true") return "on";
  if (value === "false") return "off";
  return "system";
}

export interface UseAnimationsEnabledResult {
  /** Resolved value used to drive `<html data-animations>`. */
  enabled: boolean;
  /** The user's explicit preference, or `"system"` when unset. */
  preference: AnimationsPreference;
  /** Whether the OS currently reports `prefers-reduced-motion: reduce`. */
  systemReducedMotion: boolean;
  /** Persist the user's choice. */
  setEnabled: (next: boolean) => void;
  /** The choice is on its way to the backend. */
  isSaving: boolean;
  isLoading: boolean;
}

/**
 * Resolved hook composing the user's `animations_enabled` setting with the
 * OS `prefers-reduced-motion` media query. The user setting always wins when
 * present; otherwise we honour the OS preference.
 *
 * Consumers should mount this exactly once via `<AnimationsProvider />` — the
 * provider writes `data-animations` on `<html>` and every consumer reads via
 * CSS instead of subscribing individually (keeps hot paths render-free).
 */
export function useAnimationsEnabled(): UseAnimationsEnabledResult {
  const setting = useSetting(ANIMATIONS_ENABLED_SETTING_KEY);
  const systemReducedMotion = useSystemReducedMotion();
  const preference = parseAnimationsPreference(setting.value);

  let enabled: boolean;
  if (preference === "on") enabled = true;
  else if (preference === "off") enabled = false;
  else enabled = !systemReducedMotion;

  return {
    enabled,
    preference,
    systemReducedMotion,
    setEnabled: (next: boolean) => setting.setValue(next ? "true" : "false"),
    isLoading: setting.isLoading,
    isSaving: setting.isSaving,
  };
}
