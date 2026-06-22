import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { disablePush, enablePush, getPushState, type PushState } from "@/lib/remote/push-subscribe";

export interface PushNotificationsControls {
  /** Resolved high-level push state, or "loading" until the first probe resolves. */
  state: PushState | "loading";
  /** True while an enable/disable round-trip is in flight. */
  busy: boolean;
  /** Enable (true) or disable (false) push on this device. Surfaces toasts; never throws. */
  toggle: (next: boolean) => Promise<void>;
}

/**
 * Per-device Web Push opt-in state + toggle, shared by the Settings subsection
 * and the sidebar quick toggle so the two never drift. The subscription's
 * existence is the opt-in (it never touches the shared `notification_mode`
 * setting); all failures surface as toasts rather than being swallowed.
 */
export function usePushNotifications(): PushNotificationsControls {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void getPushState().then(setState);
  }, []);

  useEffect(() => refresh(), [refresh]);

  const toggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        if (next) {
          await enablePush();
          toast.success("Push notifications enabled on this device.");
        } else {
          await disablePush();
          toast.success("Push notifications disabled on this device.");
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error("Couldn't update push notifications", { description: message });
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [refresh],
  );

  return { state, busy, toggle };
}
