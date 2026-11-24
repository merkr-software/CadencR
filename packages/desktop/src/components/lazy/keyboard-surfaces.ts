import { useEffect } from "react";
import { prefetchCommandPalette } from "@/components/CommandPalette";
import { prefetchFileSearch } from "@/components/editor/EditorFuzzyShortcut";
import { prefetchContentSearch } from "@/components/FeatureContentSearchShortcut";
import { useIsTouchDevice } from "@/hooks/useIsTouchDevice";
import { scheduleIdle } from "@/lib/schedule-idle";

/** How long the prefetch waits for an idle period before it runs anyway. */
export const KEYBOARD_SURFACE_PREFETCH_TIMEOUT_MS = 2_000;

/**
 * The dialogs a shortcut opens with a live input (⌘K, ⌘P, ⌘⇧F) are each in
 * their own chunk. Under a mouse (any layout: a narrow desktop window renders
 * the phone one) they are fetched at the first idle period after the first
 * paint, so their input is there on the frame the shortcut fires. Under a
 * finger they load on first use. Mount once, at the root.
 */
export function useKeyboardSurfacePrefetch(): void {
  const touch = useIsTouchDevice();
  useEffect(() => {
    if (touch) return undefined;
    return scheduleIdle(
      () => {
        void prefetchCommandPalette();
        void prefetchFileSearch();
        void prefetchContentSearch();
      },
      { timeout: KEYBOARD_SURFACE_PREFETCH_TIMEOUT_MS },
    );
  }, [touch]);
}
