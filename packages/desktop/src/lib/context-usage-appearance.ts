export interface ContextUsageAppearance {
  barClassName: string;
  glowColor: string;
  /** One line on what the fill level means for the conversation. */
  verdict: string;
}

export function getContextUsageAppearance(ratio: number): ContextUsageAppearance {
  if (ratio > 0.9) {
    return {
      barClassName: "bg-[var(--acc-red)]",
      glowColor: "var(--acc-red)",
      verdict: "Nearly full — the agent will have to compact soon.",
    };
  }

  if (ratio > 0.8) {
    return {
      barClassName: "bg-[var(--acc-orange)]",
      glowColor: "var(--acc-orange)",
      verdict: "Getting full — compacting now keeps the agent sharp.",
    };
  }

  if (ratio > 0.5) {
    return {
      barClassName: "bg-[var(--acc-yellow)]",
      glowColor: "var(--acc-yellow)",
      verdict: "Over half used.",
    };
  }

  return {
    barClassName: "bg-[var(--acc-green)]",
    glowColor: "var(--acc-green)",
    verdict: "Plenty of room.",
  };
}
