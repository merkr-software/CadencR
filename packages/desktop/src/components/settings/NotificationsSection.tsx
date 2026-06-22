import { createElement, useMemo, useState } from "react";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
  NOTIFICATION_MODE_KEY,
  NOTIFICATION_MODE_OPTIONS,
  parseNotificationMode,
  type NotificationMode,
} from "@/lib/notification-mode";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { SettingsCard } from "./SettingsCard";
import { SettingsSubsection } from "./SettingsSubsection";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { IconTile } from "./IconTile";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";
import { PushNotificationsSubsection } from "./PushNotificationsSubsection";

/**
 * Two-row Notifications section:
 *  1. Destination picker (System / In app / Off) — persisted via
 *     `useDebouncedSetting`, which writes through to the React Query
 *     cache that `notifyAgentDone` reads on each fire.
 *  2. "Send test" button — always fires through the OS path so users
 *     can diagnose OS-level delivery problems independently of the
 *     destination they picked.
 */
export function NotificationsSection(): React.JSX.Element {
  const [sending, setSending] = useState(false);
  const modeSetting = useDebouncedSetting(NOTIFICATION_MODE_KEY, 0);
  const mode = parseNotificationMode(modeSetting.value);

  const options = useMemo<RadioCardOption<NotificationMode>[]>(
    () =>
      NOTIFICATION_MODE_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
        visual: createElement(option.icon, {
          className: "mt-0.5 size-4",
          style: { color: option.iconColorVar },
        }),
      })),
    [],
  );

  const handleSendTest = async () => {
    setSending(true);
    try {
      await desktopBridge.notifyTest();
      toast.success("Test notification sent", {
        description: "If you don't see it, check System Settings → Notifications for Cadencr.",
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error("Couldn't send test notification", { description: message });
    } finally {
      setSending(false);
    }
  };

  return (
    <SettingsSection id="notifications" title="Notifications" subtitle="System notifications">
      <SettingsCard>
        <SettingsSubsection
          title="Notification destination"
          description="Where agent-finished notifications appear. System notifications stay visible even when Cadencr is in the background."
        >
          <RadioCardGroup<NotificationMode>
            ariaLabel="Notification destination"
            value={mode}
            onChange={modeSetting.setValue}
            options={options}
            layout="stack"
            showDot={false}
            disabled={modeSetting.isLoading}
          />
        </SettingsSubsection>
        {/* Background Web Push is the only cross-platform delivery for an
            installed PWA / remote browser, where the Electron-native path
            no-ops. Per-device opt-in, distinct from the shared destination
            picker above. */}
        {isBrowserRemote() ? <PushNotificationsSubsection /> : null}
        {/* The OS notification path only exists in the desktop shell. */}
        {isDesktopShell() ? (
          <SettingsSubsection padded={false}>
            <SettingsRow
              icon={
                <IconTile tint="yellow">
                  <Bell className="size-4" />
                </IconTile>
              }
              label="Send test notification"
              description="Always exercises the OS path so you can diagnose delivery problems independently of the destination above. If nothing appears, check System Settings → Notifications for Cadencr."
              control={
                <Button variant="outline" size="sm" onClick={handleSendTest} disabled={sending}>
                  {sending ? "Sending…" : "Send test"}
                </Button>
              }
            />
          </SettingsSubsection>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
