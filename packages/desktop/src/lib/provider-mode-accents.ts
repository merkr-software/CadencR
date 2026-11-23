import type { ProviderModeAccent } from "@/api/generated";
import type { ProviderMode } from "./provider-modes";

export const MODE_ACCENTS = {
  blue: {
    tone: "var(--chip-blue-fg)",
    chipClass:
      "bg-[var(--chip-blue-bg)]/15 text-[var(--chip-blue-fg)] hover:bg-[var(--chip-blue-bg)]/25",
  },
  green: {
    tone: "var(--acc-green)",
    chipClass: "bg-[var(--acc-green)]/15 text-[var(--acc-green)] hover:bg-[var(--acc-green)]/25",
  },
  yellow: {
    tone: "var(--acc-yellow)",
    chipClass: "bg-[var(--acc-yellow)]/15 text-[var(--acc-yellow)] hover:bg-[var(--acc-yellow)]/25",
  },
  violet: {
    tone: "var(--chip-violet-fg)",
    chipClass:
      "bg-[var(--chip-violet-bg)]/15 text-[var(--chip-violet-fg)] hover:bg-[var(--chip-violet-bg)]/25",
  },
} satisfies Record<ProviderModeAccent, Pick<ProviderMode, "tone" | "chipClass">>;
