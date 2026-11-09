import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { notifyZoomApplied } from "@/lib/zoom-coordinator";
import { useShortcut } from "./useShortcut";
import { useSetting } from "./useSetting";
import { useIsMobile } from "./useIsMobile";

// Zoom is kept per DEVICE TYPE (desktop vs mobile), not per connection: a phone
// and the desktop app each want their own level, so they persist under separate
// keys. `zoom_global` stays the desktop key to preserve existing preferences;
// mobile uses `zoom_mobile`. (The apply mechanism — native vs CSS — is chosen
// separately in `applyZoom` based on whether we're in the Electron shell.)
const ZOOM_KEY_DESKTOP = "zoom_global";
const ZOOM_KEY_MOBILE = "zoom_mobile";
const ZOOM_DEFAULT = 100;
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

function clampZoom(level: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
}

// Browsers default the root font-size to 16px; mobile zoom scales from this.
const ROOT_FONT_PX = 16;

function applyZoom(level: number): void {
  const factor = level / 100;
  // The Electron shell scales the whole webContents via the native zoom factor.
  if (isDesktopShell()) {
    void desktopBridge
      .setZoom(factor)
      .then(notifyZoomApplied)
      .catch((error: unknown) => {
        const message = apiErrorMessage(error, String(error));
        toast.error(`Could not apply zoom: ${message}`);
      });
    return;
  }
  if (typeof document === "undefined") return;
  // Remote browser tab (mobile/PWA): scale the root font-size so rem-based text
  // (and proportional rem spacing) resize. Unlike CSS `zoom`, this leaves the
  // viewport units (`--app-vh`, `vw`) untouched, so the shell stays exactly one
  // screen and never under/overflows — and iOS reliably scales rem text.
  const root = document.documentElement;
  if (factor === 1) root.style.removeProperty("font-size");
  else root.style.fontSize = `${ROOT_FONT_PX * factor}px`;
  notifyZoomApplied();
}

/**
 * Returns zoom state and actions for the *current* device type — desktop and
 * mobile read/write distinct settings and never affect each other. Call
 * `useZoomHotkeys` separately in the single root component that should own the
 * keyboard shortcuts.
 */
export function useZoom() {
  const isMobile = useIsMobile();
  const setting = useSetting(isMobile ? ZOOM_KEY_MOBILE : ZOOM_KEY_DESKTOP);
  // The level the last step asked for, so steps pressed before the previous one
  // is confirmed still add up. Never applied: the page zooms once the backend
  // confirms, and a failed write falls back to the confirmed level.
  const targetRef = useRef(ZOOM_DEFAULT);

  const hasPersistedValue = setting.value != null;
  const persisted = hasPersistedValue ? Number(setting.value) : ZOOM_DEFAULT;
  if (!setting.isSaving && (!setting.isLoading || hasPersistedValue)) {
    targetRef.current = persisted;
  }

  useEffect(() => {
    if (setting.isLoading && !hasPersistedValue) return;
    applyZoom(persisted);
  }, [hasPersistedValue, persisted, setting.isLoading]);

  const { setValue } = setting;
  const setZoom = useCallback(
    (level: number) => {
      const clamped = clampZoom(level);
      targetRef.current = clamped;
      void setValue(String(clamped));
    },
    [setValue],
  );

  const zoomIn = useCallback(() => {
    setZoom(targetRef.current + ZOOM_STEP);
  }, [setZoom]);

  const zoomOut = useCallback(() => {
    setZoom(targetRef.current - ZOOM_STEP);
  }, [setZoom]);

  const resetZoom = useCallback(() => {
    setZoom(ZOOM_DEFAULT);
  }, [setZoom]);

  return useMemo(
    () => ({ zoomLevel: persisted, zoomIn, zoomOut, resetZoom, setZoom }),
    [persisted, zoomIn, zoomOut, resetZoom, setZoom],
  );
}

/** Registers Cmd+=/Cmd+-/Cmd+0 hotkeys. Call only once (root layout). */
export function useZoomHotkeys() {
  const { zoomIn, zoomOut, resetZoom } = useZoom();

  useShortcut("zoom-in", (e) => {
    e.preventDefault();
    zoomIn();
  });
  useShortcut("zoom-out", (e) => {
    e.preventDefault();
    zoomOut();
  });
  useShortcut("zoom-reset", (e) => {
    e.preventDefault();
    resetZoom();
  });
}
