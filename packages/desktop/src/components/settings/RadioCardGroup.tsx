import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface RadioCardOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  /** Optional leading visual (e.g. theme swatch, icon, code chip). */
  visual?: ReactNode;
  disabled?: boolean;
}

/**
 * Radio-group rendered as a list (or grid) of bordered cards. Used for
 * loader-style, theme picker, autonomy, and merge-strategy pickers.
 *
 * `showDot` (default `true`) toggles the trailing radio-dot — leave it on
 * for cards with a leading swatch/visual (theme, loader), turn it off for
 * cards where the icon-only treatment is the affordance (autonomy, merge).
 */
export function RadioCardGroup<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  layout = "stack",
  columns = 2,
  showDot = true,
  disabled,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<RadioCardOption<T>>;
  ariaLabel: string;
  layout?: "stack" | "grid";
  /** Grid column count when `layout="grid"`. */
  columns?: 2 | 3;
  showDot?: boolean;
  disabled?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        layout === "grid"
          ? columns === 3
            ? "grid grid-cols-1 gap-3 sm:grid-cols-3"
            : "grid grid-cols-1 gap-3 sm:grid-cols-2"
          : "flex flex-col gap-2",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const isDisabled = disabled || option.disabled;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={isDisabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative flex w-full items-start gap-3 rounded-[10px] border bg-card px-3.5 py-3 text-left transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "border-[color-mix(in_oklab,var(--primary)_60%,transparent)] bg-[color-mix(in_oklab,var(--primary)_8%,var(--card))]"
                : "border-border hover:bg-accent",
            )}
          >
            {option.visual ? <div className="shrink-0">{option.visual}</div> : null}
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="text-sm font-medium">{option.label}</div>
              {option.description ? (
                <div className="text-[11px] text-muted-foreground leading-snug">
                  {option.description}
                </div>
              ) : null}
            </div>
            {showDot ? (
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 size-3.5 shrink-0 rounded-full border-[1.5px] transition-colors",
                  selected
                    ? "border-primary bg-primary shadow-[inset_0_0_0_3px_var(--card)]"
                    : "border-[color-mix(in_oklab,var(--muted-foreground)_70%,transparent)] bg-transparent",
                )}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
