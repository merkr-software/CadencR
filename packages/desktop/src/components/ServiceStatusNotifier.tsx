import { translateUi as t } from "@/lib/i18n/ui";
import { useEffect } from "react";
import { toast } from "sonner";
import { desktopBridge } from "@/lib/desktop-bridge";
import { showServiceStatus } from "./service-status-toast";

/**
 * Follows the packaged service as main supervises it. A window that reloads
 * while the service is down reads the current state instead of waiting for
 * the next change.
 */
export function ServiceStatusNotifier(): null {
  useEffect(() => {
    let alive = true;
    let receivedStatus = false;
    const off = desktopBridge.onServiceStatus((status) => {
      receivedStatus = true;
      showServiceStatus(status);
    });
    desktopBridge
      .serviceStatus()
      .then((status) => {
        if (alive && !receivedStatus) showServiceStatus(status);
      })
      .catch((error: unknown) =>
        toast.error(
          t("system.service.readFailed", "Could not read the state of Cadencr's service"),
          {
            description: error instanceof Error ? error.message : String(error),
          },
        ),
      );
    return () => {
      alive = false;
      off();
    };
  }, []);
  return null;
}
