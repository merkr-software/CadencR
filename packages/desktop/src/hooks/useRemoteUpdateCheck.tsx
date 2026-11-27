import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { UiTrans } from "@/lib/i18n/ui";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { isUpdateAvailable } from "@/lib/remote/update-check";

// An installed PWA can stay open for days; recheck periodically, but cheaply.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

// Stable toast id so sonner dedupes: `visibilitychange` and `focus` fire
// together on app re-entry, so several `check()` calls can be mid-`await` at
// once and all resolve true. Reusing one id collapses them onto a single toast
// (later calls update it in place) instead of stacking duplicates.
const UPDATE_TOAST_ID = "remote-update-available";

/**
 * In a remote browser / installed PWA, watch for the host serving newer frontend
 * code and surface a one-tap reload prompt. No-op in the Electron shell (which
 * updates via app releases) and on a regular desktop browser tab.
 *
 * Checks on mount, whenever the app regains focus/visibility (the moment a user
 * returns to a backgrounded PWA), and on a slow interval. The check is a single
 * cache-bypassing fetch + regex, gated so it only runs while the page is
 * visible — no main-thread or network cost while hidden.
 */
export function useRemoteUpdateCheck(): void {
  // Once the reload prompt is up, stop further checks — the toast persists until
  // acted on, so there's nothing to re-detect. (The toast `id` already prevents
  // duplicates; this just avoids redundant polling.)
  const prompted = useRef(false);

  useEffect(() => {
    if (!isBrowserRemote()) return;

    const promptReload = (): void => {
      prompted.current = true;
      toast(<UiTrans i18nKey="remote.update.available" defaults="A new version is available" />, {
        id: UPDATE_TOAST_ID,
        description: (
          <UiTrans
            i18nKey="remote.update.reloadDetail"
            defaults="Reload to get the latest Cadencr."
          />
        ),
        duration: Infinity,
        action: {
          label: <UiTrans i18nKey="common.reload" defaults="Reload" />,
          onClick: () => location.reload(),
        },
      });
    };

    const check = async (): Promise<void> => {
      if (prompted.current || document.hidden) return;
      if (await isUpdateAvailable()) promptReload();
    };

    void check();
    const onVisible = (): void => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const id = window.setInterval(() => void check(), POLL_INTERVAL_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(id);
    };
  }, []);
}
