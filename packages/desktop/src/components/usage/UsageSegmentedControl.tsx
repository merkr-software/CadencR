import { HintTooltip } from "@/components/HintTooltip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Shown in a tooltip on hover and keyboard focus. */
  title?: string;
  /** This one choice is unavailable (the others stay usable). */
  disabled?: boolean;
}

/**
 * Compact segmented control for the chart filters. Small enough to sit on a
 * card header row, which is where `interaction.md` wants chart filters — one
 * row above the plot, never inside it. An option's `title` shows in a
 * tooltip; the control brings its own provider, so it mounts anywhere.
 * `disabled` freezes the whole control (e.g. while a change is being saved).
 */
export function UsageSegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  disabled = false,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={300}>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        aria-busy={disabled || undefined}
        className={cn(
          "inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-card p-0.5",
          className,
        )}
      >
        {options.map((option) => {
          const selected = option.value === value;
          const button = (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || option.disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                selected
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
          return option.title ? (
            <HintTooltip key={option.value} hint={option.title}>
              {button}
            </HintTooltip>
          ) : (
            button
          );
        })}
      </div>
    </TooltipProvider>
  );
}
