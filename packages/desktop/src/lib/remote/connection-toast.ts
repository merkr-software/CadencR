import { toast } from "sonner";
import { useRemoteDialogStore } from "@/stores/remote-dialog-store";

/**
 * Show the "device connected" toast on the host. Fired from the
 * `app/remote_connected` WS event, which the backend emits exactly once per
 * device-connection (deduped at the live-session registry), so there's no
 * per-render / per-poll / replay spam to guard against here. Host-only by
 * construction: only the host subscribes to `remote_events` (see
 * `session-status-store`), so a remote browser never receives this event.
 */
export function showRemoteConnectedToast(): void {
  toast("Device connected", {
    description: "A remote device connected to this computer.",
    action: {
      label: "View devices",
      onClick: () => useRemoteDialogStore.getState().openDialog({ focusDevices: true }),
    },
  });
}
