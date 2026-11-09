import { createElement, useMemo } from "react";
import { useNotchCapabilities } from "@/components/notch/useNotchCapabilities";
import { RecommendedTag } from "@/components/RecommendedTag";
import { useSetting } from "@/hooks/useSetting";
import {
  NOTIFICATION_MODE_KEY,
  NOTIFICATION_MODE_OPTIONS,
  parseNotificationMode,
  type NotificationMode,
} from "@/lib/notification-mode";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";

interface NotificationModeOptionsProps {
  value: NotificationMode;
  onChange: (mode: NotificationMode) => void;
  disabled?: boolean;
  /** Tags one option "Recommended" (the onboarding's pick for this Mac). */
  recommended?: NotificationMode;
}

/**
 * Controlled destination picker (Notch / System / In app / Off). "Notch" only
 * exists in the macOS desktop shell; a device that can't host it still shows
 * it when another device picked it, disabled. On a Mac without a notch it
 * stays available, explaining the virtual island it would get.
 */
export function NotificationModeOptions({
  value,
  onChange,
  disabled,
  recommended,
}: NotificationModeOptionsProps): React.JSX.Element {
  const capabilities = useNotchCapabilities();
  const notchSupported = capabilities.data?.supported === true;
  const notchHardware = capabilities.data?.hardware === true;

  const options = useMemo<RadioCardOption<NotificationMode>[]>(
    () =>
      NOTIFICATION_MODE_OPTIONS.filter(
        (option) => option.value !== "notch" || notchSupported || value === "notch",
      ).map((option) => ({
        value: option.value,
        label:
          option.value === recommended ? (
            <span className="inline-flex items-center gap-2">
              {option.label}
              <RecommendedTag />
            </span>
          ) : (
            option.label
          ),
        description:
          option.value === "notch" && notchSupported && !notchHardware
            ? `${option.description} No notched display is connected right now, so a virtual notch sits at the top of your main screen.`
            : option.description,
        disabled: option.value === "notch" && !notchSupported,
        visual: createElement(option.icon, {
          className: "mt-0.5 size-4",
          style: { color: option.iconColorVar },
        }),
      })),
    [notchHardware, notchSupported, recommended, value],
  );

  return (
    <RadioCardGroup<NotificationMode>
      ariaLabel="Notification destination"
      value={value}
      onChange={onChange}
      options={options}
      layout="stack"
      showDot={false}
      disabled={disabled || capabilities.isLoading}
    />
  );
}

/**
 * The destination picker persisted under `NOTIFICATION_MODE_KEY` on every
 * pick, as the Settings → Notifications section uses it.
 */
export function NotificationModePicker(): React.JSX.Element {
  const modeSetting = useSetting(NOTIFICATION_MODE_KEY);
  return (
    <NotificationModeOptions
      value={parseNotificationMode(modeSetting.value)}
      onChange={modeSetting.setValue}
      disabled={modeSetting.isLoading}
    />
  );
}
