import { AppWindow, Bell, BellOff, LaptopMinimal, type LucideIcon } from "lucide-react";

export const NOTIFICATION_MODE_KEY = "notification_mode";

export const NOTIFICATION_MODE_VALUES = ["native", "in_app", "notch", "off"] as const;
export type NotificationMode = (typeof NOTIFICATION_MODE_VALUES)[number];

export const DEFAULT_NOTIFICATION_MODE: NotificationMode = "native";

export interface NotificationModeOption {
  value: NotificationMode;
  label: string;
  description: string;
  icon: LucideIcon;
  /** CSS variable for the icon's accent color. */
  iconColorVar: string;
}

export const NOTIFICATION_MODE_OPTIONS: readonly NotificationModeOption[] = [
  {
    value: "notch",
    label: "Notch",
    description:
      "Agents live in your Mac's notch. Finished and blocked agents peek out of it; hover it to see every agent and jump into a conversation.",
    icon: LaptopMinimal,
    iconColorVar: "var(--primary)",
  },
  {
    value: "native",
    label: "System",
    description:
      "Native OS notification. Visible from anywhere, even when Cadencr is in the background.",
    icon: Bell,
    iconColorVar: "var(--acc-blue)",
  },
  {
    value: "in_app",
    label: "In app",
    description: "Toast inside Cadencr. Visible only when the app is open.",
    icon: AppWindow,
    iconColorVar: "var(--acc-yellow)",
  },
  {
    value: "off",
    label: "Off",
    description: "Don't show any notification when an agent finishes.",
    icon: BellOff,
    iconColorVar: "var(--muted-foreground)",
  },
] as const;

export function parseNotificationMode(value: string | null | undefined): NotificationMode {
  return NOTIFICATION_MODE_VALUES.includes(value as NotificationMode)
    ? (value as NotificationMode)
    : DEFAULT_NOTIFICATION_MODE;
}
