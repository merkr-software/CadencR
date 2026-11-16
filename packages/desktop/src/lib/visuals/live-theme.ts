import { useSyncExternalStore } from "react";
import type { ThemeSnapshot } from "@cadencr/tab-sdk/protocol";

import { currentLiveTheme, subscribeLiveTheme } from "@/lib/themes/live-theme";

/** What agent visuals paint with: the live theme tokens plus the UI fonts. */
export interface VisualTheme {
  /** Changes exactly when the theme does: remounts what cannot repaint in place. */
  key: string;
  snapshot: ThemeSnapshot;
  fontSans: string;
  fontMono: string;
}

const FALLBACK_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

let current: VisualTheme | null = null;
let version = 0;

/**
 * The theme for visuals, rebuilt when the shared theme snapshot changes. Fonts
 * are read alongside: a font override alone reaches visuals as they remount.
 */
function getSnapshot(): VisualTheme {
  const snapshot = currentLiveTheme();
  if (current?.snapshot === snapshot) return current;
  version += 1;
  current = {
    key: String(version),
    snapshot,
    // `--font-sans` is baked into utilities (`@theme inline`), so read the face
    // the body actually renders with.
    fontSans: getComputedStyle(document.body).fontFamily,
    fontMono:
      getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
      FALLBACK_MONO,
  };
  return current;
}

/** The live theme for visuals; a new object exactly when the theme changed. */
export function useVisualTheme(): VisualTheme {
  return useSyncExternalStore(subscribeLiveTheme, getSnapshot, getSnapshot);
}
