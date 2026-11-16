import { useMemo } from "react";
import { useGetWorkspaceSetting } from "@/api/generated";
import {
  DEFAULT_NOTCH_PREFS,
  notchDisplayModeSchema,
  notchPrimaryStyleSchema,
  type NotchPrefs,
} from "@/shared/notch";

export const NOTCH_DISPLAY_MODE_KEY = "notch_display_mode";
export const NOTCH_PRIMARY_STYLE_KEY = "notch_primary_style";
export const NOTCH_ALWAYS_ON_KEY = "notch_always_on";
export const NOTCH_ALWAYS_ANIMATE_KEY = "notch_always_animate";

function parseFlag(value: string | null | undefined, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function parseNotchPrefs(values: {
  displayMode?: string | null;
  primaryStyle?: string | null;
  alwaysOn: string | null | undefined;
  alwaysAnimate: string | null | undefined;
}): NotchPrefs {
  return {
    displayMode:
      notchDisplayModeSchema.safeParse(values.displayMode).data ?? DEFAULT_NOTCH_PREFS.displayMode,
    primaryStyle:
      notchPrimaryStyleSchema.safeParse(values.primaryStyle).data ??
      DEFAULT_NOTCH_PREFS.primaryStyle,
    alwaysOn: parseFlag(values.alwaysOn, DEFAULT_NOTCH_PREFS.alwaysOn),
    alwaysAnimate: parseFlag(values.alwaysAnimate, DEFAULT_NOTCH_PREFS.alwaysAnimate),
  };
}

/** The user's notch island settings, with their defaults while unset. */
export function useNotchPrefs(): NotchPrefs {
  const displayMode = useGetWorkspaceSetting(NOTCH_DISPLAY_MODE_KEY).data?.value;
  const primaryStyle = useGetWorkspaceSetting(NOTCH_PRIMARY_STYLE_KEY).data?.value;
  const alwaysOn = useGetWorkspaceSetting(NOTCH_ALWAYS_ON_KEY).data?.value;
  const alwaysAnimate = useGetWorkspaceSetting(NOTCH_ALWAYS_ANIMATE_KEY).data?.value;
  return useMemo(
    () => parseNotchPrefs({ displayMode, primaryStyle, alwaysOn, alwaysAnimate }),
    [displayMode, primaryStyle, alwaysAnimate, alwaysOn],
  );
}
