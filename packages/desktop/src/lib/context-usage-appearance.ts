import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
export interface ContextUsageAppearance {
  barClassName: string;
  glowColor: string;
  /** One line on what the fill level means for the conversation. */
  verdict: string;
}

export function getContextUsageAppearance(
  ratio: number,
  t: UiTranslator = translateUi,
): ContextUsageAppearance {
  if (ratio > 0.9) {
    return {
      barClassName: "bg-[var(--acc-red)]",
      glowColor: "var(--acc-red)",
      verdict: t(
        "conversation.composer.context-usage-appearance.nearlyFull",
        "Nearly full — the agent will have to compact soon.",
      ),
    };
  }

  if (ratio > 0.8) {
    return {
      barClassName: "bg-[var(--acc-orange)]",
      glowColor: "var(--acc-orange)",
      verdict: t(
        "conversation.composer.context-usage-appearance.gettingFull",
        "Getting full — compacting now keeps the agent sharp.",
      ),
    };
  }

  if (ratio > 0.5) {
    return {
      barClassName: "bg-[var(--acc-yellow)]",
      glowColor: "var(--acc-yellow)",
      verdict: t("conversation.composer.context-usage-appearance.overHalf", "Over half used."),
    };
  }

  return {
    barClassName: "bg-[var(--acc-green)]",
    glowColor: "var(--acc-green)",
    verdict: t("conversation.composer.context-usage-appearance.room", "Plenty of room."),
  };
}
