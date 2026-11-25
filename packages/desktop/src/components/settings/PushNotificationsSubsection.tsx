import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { type PushState } from "@/lib/remote/push-subscribe";
import { SettingsGroup } from "./SettingsGroup";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";
import { SettingsRow } from "./SettingsRow";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/**
 * Per-device Web Push opt-in, shown only in the remote/PWA shell. The toggle
 * subscribes/unsubscribes this device; the subscription's existence is the
 * opt-in (it never touches the shared `notification_mode` setting). Surfaces
 * permission and iOS-install state so a user isn't left with a dead button.
 * Shares state + toggle with the sidebar quick toggle via `usePushNotifications`.
 */
export function PushNotificationsSubsection(): React.JSX.Element {
  const { t } = useUiTranslation();
  const { state, busy, toggle } = usePushNotifications();

  return (
    <SettingsGroup
      id={SETTINGS_ANCHORS.push}
      title={t("settings.notifications.push.title", "Push notifications on this device")}
      description={t(
        "settings.notifications.push.description",
        "A native notification when an agent finishes or needs input, even with this tab in the background or closed.",
      )}
    >
      {renderBody(state, busy, toggle, t)}
    </SettingsGroup>
  );
}

function renderBody(
  state: PushState | "loading",
  busy: boolean,
  onToggle: (next: boolean) => void,
  t: UiTranslator,
): React.JSX.Element {
  if (state === "loading") {
    return (
      <InfoRow
        description={t(
          "settings.notifications.push.checking",
          "Checking push notification support…",
        )}
      />
    );
  }
  if (state === "unsupported") {
    return (
      <InfoRow
        description={t(
          "settings.notifications.push.unsupported",
          "This browser doesn't support push notifications.",
        )}
      />
    );
  }
  if (state === "ios-needs-install") {
    return (
      <InfoRow
        description={t(
          "settings.notifications.push.iosInstall",
          "On iOS, add Cadencr to your Home Screen (Share → Add to Home Screen), then reopen it from the icon to enable push.",
        )}
      />
    );
  }
  if (state === "denied") {
    return (
      <InfoRow
        description={t(
          "settings.notifications.push.blocked",
          "Notifications are blocked. Allow notifications for this site in your browser settings, then try again.",
        )}
      />
    );
  }
  return (
    <SettingsSwitchRow
      label={t("settings.notifications.push.enable", "Enable on this device")}
      description={
        state === "on"
          ? t(
              "settings.notifications.push.onDescription",
              "This device will receive background notifications.",
            )
          : t(
              "settings.notifications.push.offDescription",
              "Turn on to receive background notifications on this device.",
            )
      }
      checked={state === "on"}
      onCheckedChange={onToggle}
      disabled={busy}
    />
  );
}

function InfoRow({ description }: { description: string }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsRow
      label={t("settings.notifications.push.label", "Push notifications")}
      description={description}
    />
  );
}
