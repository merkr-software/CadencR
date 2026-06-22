import { BellRing } from "lucide-react";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { type PushState } from "@/lib/remote/push-subscribe";
import { SettingsSubsection } from "./SettingsSubsection";
import { SettingsRow } from "./SettingsRow";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { IconTile } from "./IconTile";

/**
 * Per-device Web Push opt-in, shown only in the remote/PWA shell. The toggle
 * subscribes/unsubscribes this device; the subscription's existence is the
 * opt-in (it never touches the shared `notification_mode` setting). Surfaces
 * permission and iOS-install state so a user isn't left with a dead button.
 * Shares state + toggle with the sidebar quick toggle via `usePushNotifications`.
 */
export function PushNotificationsSubsection(): React.JSX.Element {
  const { state, busy, toggle } = usePushNotifications();

  return (
    <SettingsSubsection
      title="Push notifications (this device)"
      description="Get a native notification when an agent finishes or needs input, even when this tab is in the background or closed."
    >
      {renderBody(state, busy, toggle)}
    </SettingsSubsection>
  );
}

function renderBody(
  state: PushState | "loading",
  busy: boolean,
  onToggle: (next: boolean) => void,
): React.JSX.Element {
  if (state === "loading") {
    return <InfoRow description="Checking push notification support…" />;
  }
  if (state === "unsupported") {
    return <InfoRow description="This browser doesn't support push notifications." />;
  }
  if (state === "ios-needs-install") {
    return (
      <InfoRow description="On iOS, add Cadencr to your Home Screen (Share → Add to Home Screen), then reopen it from the icon to enable push." />
    );
  }
  if (state === "denied") {
    return (
      <InfoRow description="Notifications are blocked. Allow notifications for this site in your browser settings, then try again." />
    );
  }
  return (
    <SettingsSwitchRow
      icon={<BellRing className="size-4" />}
      iconTint="cyan"
      label="Enable on this device"
      description={
        state === "on"
          ? "This device will receive background notifications."
          : "Turn on to receive background notifications on this device."
      }
      checked={state === "on"}
      onCheckedChange={onToggle}
      disabled={busy}
    />
  );
}

function InfoRow({ description }: { description: string }): React.JSX.Element {
  return (
    <SettingsRow
      icon={
        <IconTile tint="muted">
          <BellRing className="size-4" />
        </IconTile>
      }
      label="Push notifications"
      description={description}
    />
  );
}
