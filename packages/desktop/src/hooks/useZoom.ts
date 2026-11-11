import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useGetWorkspaceSetting } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { notifyZoomApplied } from "@/lib/zoom-coordinator";
import { parseZoomLevel, stepZoom, type ZoomStep } from "@/lib/zoom-level";
import { useShortcut } from "./useShortcut";
import { useSetting, type Setting } from "./useSetting";
import { useIsMobile } from "./useIsMobile";

// The app zoom scales the whole window. It is kept per DEVICE TYPE (desktop vs
// mobile), not per connection: a phone and the desktop app each want their own
// level, so they persist under separate keys. `zoom_global` stays the desktop
// key to preserve existing preferences; mobile uses `zoom_mobile`. (The apply
// mechanism — native vs CSS — is chosen separately in `applyZoom`.)
//
// A zoom per workspace tab (agent, editor, terminal) would be a separate scope
// applied inside the tab: the native factor below is shared by the whole window.
const ZOOM_KEY_DESKTOP = "zoom_global";
const ZOOM_KEY_MOBILE = "zoom_mobile";

export type ZoomDevice = "desktop" | "mobile";

/**
 * The Electron shell is always the desktop device. Zooming in narrows its CSS
 * viewport, so going by width would swap in the phone level past the breakpoint
 * and bounce between the two levels.
 */
export function zoomDevice(inDesktopShell: boolean, isPhoneViewport: boolean): ZoomDevice {
  return !inDesktopShell && isPhoneViewport ? "mobile" : "desktop";
}

function zoomSettingKey(device: ZoomDevice): string {
  return device === "mobile" ? ZOOM_KEY_MOBILE : ZOOM_KEY_DESKTOP;
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

interface ZoomState {
  key: string;
  device: ZoomDevice;
  setting: Setting;
  zoomLevel: number;
  step: (step: ZoomStep) => void;
}

function useZoomState(): ZoomState {
  const device = zoomDevice(isDesktopShell(), useIsMobile());
  const key = zoomSettingKey(device);
  const setting = useSetting(key);
  const { setValue } = setting;
  // Each step applies to the level the backend confirmed when its write goes
  // out, so quick steps add up across callers. A level that never loaded is
  // left alone rather than overwritten from a guess.
  const step = useCallback(
    (next: ZoomStep) => {
      void setValue((confirmed) =>
        confirmed === undefined ? null : String(stepZoom(parseZoomLevel(confirmed), next)),
      );
    },
    [setValue],
  );
  return { key, device, setting, zoomLevel: parseZoomLevel(setting.value), step };
}

/**
 * The app zoom of the *current* device type and its controls. Reading it never
 * changes the zoom: only {@link useAppZoom}, mounted once, applies it.
 */
export function useZoom() {
  const { device, zoomLevel, step } = useZoomState();
  return useMemo(() => ({ device, zoomLevel, step }), [device, zoomLevel, step]);
}

/**
 * Owns the app zoom: applies the confirmed level and registers Cmd+=/Cmd+-/Cmd+0.
 * Call only once (root layout); a second owner would re-apply on mount.
 */
export function useAppZoom(): void {
  const { key, setting, zoomLevel, step } = useZoomState();
  const { error } = useGetWorkspaceSetting(key);
  // Unset applies the default; a level that failed to load keeps the current
  // zoom instead of resetting it until a later fetch succeeds.
  const known = setting.value != null || (setting.isFetched && error == null);

  useEffect(() => {
    if (known) applyZoom(zoomLevel);
  }, [known, zoomLevel]);

  useEffect(() => {
    if (known || error == null) return;
    toast.error(`Could not load the zoom level: ${apiErrorMessage(error, "Unknown error")}`, {
      id: "zoom-load-error",
    });
  }, [known, error]);

  useShortcut("zoom-in", (e) => {
    e.preventDefault();
    step("in");
  });
  useShortcut("zoom-out", (e) => {
    e.preventDefault();
    step("out");
  });
  useShortcut("zoom-reset", (e) => {
    e.preventDefault();
    step("reset");
  });
}
