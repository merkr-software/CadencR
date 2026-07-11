import { createElement, useMemo } from "react";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
  NOTIFICATION_MODE_KEY,
  NOTIFICATION_MODE_OPTIONS,
  parseNotificationMode,
  type NotificationMode,
} from "@/lib/notification-mode";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";

/**
 * Destination picker (System / In app / Off) for agent-finished notifications,
 * persisted via `useDebouncedSetting` under `NOTIFICATION_MODE_KEY`. Shared by
 * the Settings → Notifications section and the onboarding Preferences step so
 * the option list and persistence stay in one place.
 */
export function NotificationModePicker(): React.JSX.Element {
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

  return (
    <RadioCardGroup<NotificationMode>
      ariaLabel="Notification destination"
      value={mode}
      onChange={modeSetting.setValue}
      options={options}
      layout="stack"
      showDot={false}
      disabled={modeSetting.isLoading}
    />
  );
}
