import { useEffect } from "react";
import { toastError } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { followInstallWhenAgentsFinish, useUpdateStore } from "@/stores/update-store";

/**
 * Mirror the main process's auto-updater state into the renderer store: read
 * the current state on mount (so a reload or a new window picks up a pending
 * or ready update), then follow every change, and start the install a
 * pending "when agents finish" wish waits for. Mount once from the root layout.
 *
 * UI surfacing (a sidebar button + dialog) lives in `SidebarUpdateButton` —
 * we deliberately do NOT show a toast here, since updates are persistent
 * state that belongs in a discoverable, non-ephemeral affordance.
 */
export function useAutoUpdateBridge(): void {
  useEffect(() => {
    const { receive } = useUpdateStore.getState();
    // Subscribe before reading so no change slips between the two; `receive`
    // keeps whichever snapshot is newer.
    const unsubscribe = desktopBridge.onUpdateState(receive);
    const stopFollowing = followInstallWhenAgentsFinish();
    desktopBridge
      .getUpdateState()
      .then(receive)
      .catch((error: unknown) => toastError(error, "Could not read the update status."));
    return () => {
      unsubscribe();
      stopFollowing();
    };
  }, []);
}
