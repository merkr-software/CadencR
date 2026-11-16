import { memo, type ReactElement } from "react";
import { useSetting } from "@/hooks/useSetting";
import {
  CONTEXT_METER_DISPLAY_LABEL,
  CONTEXT_METER_DISPLAY_SETTING_KEY,
  nextContextMeterDisplay,
  parseContextMeterDisplay,
  type ContextMeterDisplay,
} from "@/lib/context-meter-display";
import { contextUsageToShow, totalTokens, usageRatio, type ContextUsageState } from "@/types/agent";
import { formatCompactTokens } from "@/components/usage/usage-chart-palette";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { contextUsageAriaLabel, UsageMeter, useHoverOpen } from "../ContextUsageBar";
import { ContextWindowCard } from "./ContextWindowCard";
import { useComposerContext } from "./ComposerContext";

/**
 * Context-window meter of the composer's instrument row. Hover for the
 * details card; click to change how it reads (bar and percentage, percentage,
 * tokens used / window, tokens left, bar only) — a global preference.
 */
export const ContextMeter = memo(function ContextMeter(): ReactElement | null {
  const { contextUsage, isRunning } = useComposerContext();
  const shown = contextUsageToShow(contextUsage, isRunning);
  if (!shown) return null;
  return <ContextMeterTrigger usage={shown} isStreaming={isRunning} />;
});

function ContextMeterTrigger({
  usage,
  isStreaming,
}: {
  usage: ContextUsageState;
  isStreaming: boolean;
}): ReactElement {
  const hover = useHoverOpen();
  const setting = useSetting(CONTEXT_METER_DISPLAY_SETTING_KEY);
  const display = parseContextMeterDisplay(setting.value);
  const ratio = usageRatio(usage);
  const label = meterLabel(display, usage, ratio);

  return (
    <Popover open={hover.open} onOpenChange={hover.setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-context-meter={display}
          aria-busy={setting.isSaving || undefined}
          aria-label={`${contextUsageAriaLabel(usage, ratio)}. Showing ${CONTEXT_METER_DISPLAY_LABEL[display]}; click to change.`}
          className="composer-instrument gap-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          {...hover.triggerProps}
          onClick={(event) => {
            // Clicking changes the reading; the card stays where hover put it.
            event.preventDefault();
            setting.setValue(nextContextMeterDisplay(display));
          }}
        >
          {(label === null || display === "bar_percent") && (
            // A bar beside a label steps aside on a narrow card; a lone bar stays.
            <span data-context-meter-bar={label === null ? undefined : true} className="contents">
              <UsageMeter ratio={ratio} isStreaming={isStreaming} className="w-10 flex-none" />
            </span>
          )}
          {label !== null && (
            <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
              {label}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="pointer-events-none w-auto p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextWindowCard usage={usage} ratio={ratio} display={display} />
      </PopoverContent>
    </Popover>
  );
}

/** The meter's text for a display, or null when it shows the bar alone. */
function meterLabel(
  display: ContextMeterDisplay,
  usage: ContextUsageState,
  ratio: number | null,
): string | null {
  const used = totalTokens(usage);
  // Without a reported window there is no share to show: tokens used it is.
  if (ratio == null || !usage.contextWindow) return used > 0 ? formatCompactTokens(used) : "—";
  switch (display) {
    case "bar":
      return null;
    case "tokens":
      return `${formatCompactTokens(used)} / ${formatCompactTokens(usage.contextWindow)}`;
    case "left":
      return `${formatCompactTokens(Math.max(0, usage.contextWindow - used))} left`;
    default:
      return `${Math.round(ratio * 100)}%`;
  }
}
