import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { SettingsGroup } from "./SettingsGroup";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";
import { SettingsSubsection } from "./SettingsSubsection";
import { SettingsRow } from "./SettingsRow";
import { SettingsPageSection } from "./SettingsPageSection";
import { NotificationModePicker } from "./NotificationModePicker";
import { NotchSettings } from "./NotchSettings";
import { PushNotificationsSubsection } from "./PushNotificationsSubsection";
import { apiErrorMessage } from "@/lib/api-errors";

/**
 * Settings → Notifications:
 *  1. Destination picker (Notch / System / In app / Off) — persisted via
 *     `useDebouncedSetting`, which writes through to the React Query
 *     cache that `notifyAgentDone` reads on each fire.
 *  2. Per-device push (remote shell) and the notch island (macOS), when
 *     they apply.
 *  3. "Send test" button — always fires through the OS path so users
 *     can diagnose OS-level delivery problems independently of the
 *     destination they picked.
 */
export function NotificationsSection(): React.JSX.Element {
  const [sending, setSending] = useState(false);

  const handleSendTest = async () => {
    setSending(true);
    try {
      await desktopBridge.notifyTest();
      toast.success("Test notification sent", {
        description: "Nothing showing? Allow notifications for Cadencr in your system's settings.",
      });
    } catch (e: unknown) {
      const message = apiErrorMessage(e, String(e));
      toast.error("Couldn't send test notification", { description: message });
    } finally {
      setSending(false);
    }
  };

  return (
    <SettingsPageSection pageId="notifications">
      <SettingsGroup
        id={SETTINGS_ANCHORS.notificationDestination}
        title="Destination"
        description="System notifications stay visible while Cadencr is in the background."
      >
        <SettingsSubsection>
          <NotificationModePicker />
        </SettingsSubsection>
      </SettingsGroup>
      {/* Background Web Push is the only cross-platform delivery for an
          installed PWA / remote browser, where the Electron-native path
          no-ops. Per-device opt-in, distinct from the shared destination
          picker above. */}
      {isBrowserRemote() ? <PushNotificationsSubsection /> : null}
      <NotchSettings />
      {/* The OS notification path only exists in the desktop shell. */}
      {isDesktopShell() ? (
        <SettingsGroup id={SETTINGS_ANCHORS.notificationTest} title="Troubleshooting">
          <SettingsRow
            label="Send a test notification"
            description="Always goes through the operating system, whatever the destination above, so you can tell a delivery problem from a setting. Nothing shows up? Allow notifications for Cadencr in your system's settings."
            control={
              <Button variant="outline" size="sm" onClick={handleSendTest} disabled={sending}>
                {sending ? "Sending…" : "Send test"}
              </Button>
            }
          />
        </SettingsGroup>
      ) : null}
    </SettingsPageSection>
  );
}
