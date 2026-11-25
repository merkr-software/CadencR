import type { useUiTranslation } from "@/lib/i18n/ui";
import { AppWindow, Bell, BellOff, LaptopMinimal, type LucideIcon } from "lucide-react";

export const NOTIFICATION_MODE_KEY = "notification_mode";

export const NOTIFICATION_MODE_VALUES = ["native", "in_app", "notch", "off"] as const;
export type NotificationMode = (typeof NOTIFICATION_MODE_VALUES)[number];

export const DEFAULT_NOTIFICATION_MODE: NotificationMode = "native";

export interface NotificationModeOption {
  value: NotificationMode;
  label: (t: ReturnType<typeof useUiTranslation>["t"]) => string;
  description: (t: ReturnType<typeof useUiTranslation>["t"]) => string;
  icon: LucideIcon;
  /** CSS variable for the icon's accent color. */
  iconColorVar: string;
}

export const NOTIFICATION_MODE_OPTIONS: readonly NotificationModeOption[] = [
  {
    value: "notch",
    label: (t) => t("settings.notifications.notch.label", "Notch"),
    description: (t) =>
      t(
        "settings.notifications.notch.description",
        "Agents live in your Mac's notch. Finished and blocked agents peek out of it; hover it to see every agent and jump into a conversation.",
      ),
    icon: LaptopMinimal,
    iconColorVar: "var(--primary)",
  },
  {
    value: "native",
    label: (t) => t("settings.notifications.native.label", "System"),
    description: (t) =>
      t(
        "settings.notifications.native.description",
        "Native OS notification. Visible from anywhere, even when Cadencr is in the background.",
      ),
    icon: Bell,
    iconColorVar: "var(--acc-blue)",
  },
  {
    value: "in_app",
    label: (t) => t("settings.notifications.inApp.label", "In app"),
    description: (t) =>
      t(
        "settings.notifications.inApp.description",
        "Toast inside Cadencr. Visible only when the app is open.",
      ),
    icon: AppWindow,
    iconColorVar: "var(--acc-yellow)",
  },
  {
    value: "off",
    label: (t) => t("settings.notifications.off.label", "Off"),
    description: (t) =>
      t(
        "settings.notifications.off.description",
        "Don't show any notification when an agent finishes.",
      ),
    icon: BellOff,
    iconColorVar: "var(--muted-foreground)",
  },
] as const;

export function parseNotificationMode(value: string | null | undefined): NotificationMode {
  return NOTIFICATION_MODE_VALUES.includes(value as NotificationMode)
    ? (value as NotificationMode)
    : DEFAULT_NOTIFICATION_MODE;
}
