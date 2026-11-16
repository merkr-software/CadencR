/**
 * Holds an idle-system-sleep block while ALL of these are true:
 *   - running in the desktop shell on the host (not a remote tab);
 *   - the user enabled "Prevent sleep while hosting";
 *   - remote access is currently on.
 *
 * The actual `powerSaveBlocker('prevent-app-suspension')` lives in the Electron
 * main process under the `"remote-host"` reason (see `electron/main/power.ts`),
 * held independently of the agent-busy blocker. This hook just computes the
 * desired state and forwards it; main keeps it idempotent. Releasing it is
 * covered on every transition (toggle off, remote disabled) and on unmount, so
 * a reload during dev can't strand the assertion. App quit clears it in
 * `shutdownPower`.
 */
import { useEffect } from "react";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { canPreventHostSleep, useRemotePreventSleep } from "@/lib/remote/sleep-prevention";
import { useRemoteStore } from "@/stores/remote-store";

export function useRemoteSleepGuard(): void {
  const remoteEnabled = useRemoteStore((s) => s.status?.enabled ?? false);
  const [preventSleep] = useRemotePreventSleep();

  useEffect(() => {
    if (!canPreventHostSleep(desktopBridge.isElectron, isBrowserRemote())) return;

    const shouldPrevent = preventSleep && remoteEnabled;
    void desktopBridge.setRemoteHostAwake(shouldPrevent).catch((error: unknown) => {
      const message = apiErrorMessage(error, String(error));
      console.warn(`power:set-remote-host failed: ${message}`);
    });

    return () => {
      // Release on teardown so an HMR reload doesn't leave the system awake.
      void desktopBridge.setRemoteHostAwake(false).catch(() => {
        /* unmount cleanup — nothing actionable */
      });
    };
  }, [preventSleep, remoteEnabled]);
}
