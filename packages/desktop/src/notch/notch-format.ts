import { formatExactNumber } from "@/lib/format-number";
import type { UiTranslator } from "@/lib/i18n/ui";

export function formatSnoozeDuration(minutes: number, t: UiTranslator, locale: string): string {
  if (minutes < 60)
    return t("notch.time.minutes", "{{formattedCount}}m", {
      formattedCount: formatExactNumber(minutes, locale),
    });
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0
    ? t("notch.time.hours", "{{formattedCount}}h", {
        formattedCount: formatExactNumber(hours, locale),
      })
    : t("notch.time.hoursAndMinutes", "{{hours}}h{{minutes}}", {
        hours: formatExactNumber(hours, locale),
        minutes: formatExactNumber(remainder, locale),
      });
}

/** Compact age of a finished turn: "now", "4m", "2h", "3d". */
export function formatAge(ms: number, t: UiTranslator, locale: string): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t("notch.time.now", "now");
  if (minutes < 60)
    return t("notch.time.minutes", "{{formattedCount}}m", {
      formattedCount: formatExactNumber(minutes, locale),
    });
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return t("notch.time.hours", "{{formattedCount}}h", {
      formattedCount: formatExactNumber(hours, locale),
    });
  return t("notch.time.days", "{{formattedCount}}d", {
    formattedCount: formatExactNumber(Math.floor(hours / 24), locale),
  });
}
