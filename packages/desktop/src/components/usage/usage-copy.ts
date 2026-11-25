import { formatExactNumber } from "@/lib/format-number";
import type { UiTranslator } from "@/lib/i18n/ui";
import type { UsageMetric } from "./usage-stats-model";

export function emptyUsageRange(t: UiTranslator, metric: UsageMetric): string {
  switch (metric) {
    case "total":
      return t("system.usage.emptyTokens", "No tokens exchanged in this range yet.");
    case "input":
      return t("system.usage.emptyInput", "No input tokens in this range yet.");
    case "output":
      return t("system.usage.emptyOutput", "No output tokens in this range yet.");
    case "messages":
      return t("system.usage.emptyMessages", "No messages sent in this range yet.");
  }
}

export function usageChartLabel(t: UiTranslator, metric: UsageMetric): string {
  switch (metric) {
    case "total":
      return t(
        "system.usage.dailyTokens",
        "Daily tokens exchanged. Use the left and right arrow keys to read each day.",
      );
    case "input":
      return t(
        "system.usage.dailyInput",
        "Daily input tokens. Use the left and right arrow keys to read each day.",
      );
    case "output":
      return t(
        "system.usage.dailyOutput",
        "Daily output tokens. Use the left and right arrow keys to read each day.",
      );
    case "messages":
      return t(
        "system.usage.dailyMessages",
        "Daily messages sent. Use the left and right arrow keys to read each day.",
      );
  }
}

export function usageColumnLabel(
  t: UiTranslator,
  metric: UsageMetric,
  date: string,
  count: number,
  locale: string,
): string {
  const values = { date, count, formattedCount: formatExactNumber(count, locale) };
  switch (metric) {
    case "total":
      return t("system.usage.dayTokens", "{{date}}: {{formattedCount}} tokens exchanged", {
        ...values,
        defaultValue_zero: "{{date}}: {{formattedCount}} tokens exchanged",
        defaultValue_one: "{{date}}: {{formattedCount}} token exchanged",
        defaultValue_other: "{{date}}: {{formattedCount}} tokens exchanged",
      });
    case "input":
      return t("system.usage.dayInput", "{{date}}: {{formattedCount}} input tokens", {
        ...values,
        defaultValue_zero: "{{date}}: {{formattedCount}} input tokens",
        defaultValue_one: "{{date}}: {{formattedCount}} input token",
        defaultValue_other: "{{date}}: {{formattedCount}} input tokens",
      });
    case "output":
      return t("system.usage.dayOutput", "{{date}}: {{formattedCount}} output tokens", {
        ...values,
        defaultValue_zero: "{{date}}: {{formattedCount}} output tokens",
        defaultValue_one: "{{date}}: {{formattedCount}} output token",
        defaultValue_other: "{{date}}: {{formattedCount}} output tokens",
      });
    case "messages":
      return t("system.usage.dayMessages", "{{date}}: {{formattedCount}} messages sent", {
        ...values,
        defaultValue_zero: "{{date}}: {{formattedCount}} messages sent",
        defaultValue_one: "{{date}}: {{formattedCount}} message sent",
        defaultValue_other: "{{date}}: {{formattedCount}} messages sent",
      });
  }
}
