import { memo } from "react";
import { ChevronsDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import { ShortcutTooltip } from "../ShortcutTooltip";
import { AUTO_SCROLL_ACTIVE_CHIP, META_BAR_CHIP } from "./meta-bar-chip-styles";

interface AutoScrollChipProps {
  enabled: boolean;
  onToggle: () => void;
  /** `instrument`: the composer card's quiet instrument row (no tinted chip). */
  variant?: "chip" | "instrument";
}

/**
 * Compact icon-only toggle for auto-scroll, rendered on the composer's
 * utility strip — the single source of truth for its visuals, a11y and
 * tooltip copy.
 *
 * The tooltip is left-aligned because the agent session sits on the left of
 * the workspace; a centered tooltip would clip behind the sidebar.
 */
export const AutoScrollChip = memo(function AutoScrollChip({
  enabled,
  onToggle,
  variant = "chip",
}: AutoScrollChipProps) {
  const autoScrollKeys = useShortcutKeys("agent-autoscroll");
  return (
    <ShortcutTooltip
      label={
        enabled
          ? "Auto-scroll: on — follow new agent output"
          : "Auto-scroll: off — click to follow new agent output"
      }
      keys={autoScrollKeys}
      alignLeft
    >
      <button
        type="button"
        aria-label="Auto-scroll"
        aria-pressed={enabled}
        data-auto-scroll-chip
        onClick={onToggle}
        className={
          variant === "instrument"
            ? cn(
                "composer-instrument composer-instrument-icon",
                enabled ? "text-[var(--acc-green)]" : "text-muted-foreground",
              )
            : cn(
                META_BAR_CHIP,
                "px-2",
                enabled
                  ? AUTO_SCROLL_ACTIVE_CHIP
                  : "bg-muted/50 text-muted-foreground hover:bg-muted/80",
              )
        }
      >
        {/* Chevrons, not an arrow onto a line — that one reads as "download". */}
        <ChevronsDownIcon className="size-3.5" />
      </button>
    </ShortcutTooltip>
  );
});
