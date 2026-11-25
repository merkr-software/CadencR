import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";
import type { ThemeDefinition } from "@/lib/themes";
import { themeAppearanceLabel, themeDisplayLabel } from "@/lib/themes/display";
import { ThemeSwatch } from "./ThemeSwatch";

/**
 * One theme, offered for choosing: its swatch, its name, its appearance.
 *
 * A radio rather than a toggle — everywhere a theme is offered, exactly one of
 * the set is chosen — so the container has to be a `radiogroup` and own the
 * arrow-key movement between cards, including which card is the tab stop.
 * Shape is the caller's: the drawer lays these out as a fixed-width carousel,
 * the create dialog as a grid.
 */
export function ThemeCard({
  theme,
  selected,
  disabled,
  tabIndex,
  onSelect,
  className,
}: {
  theme: ThemeDefinition;
  selected: boolean;
  disabled: boolean;
  tabIndex: number;
  onSelect: () => void;
  className?: string;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-theme-card={theme.id}
      tabIndex={tabIndex}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-start gap-1.5 rounded-md border text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-primary/60 bg-primary/8"
          : "border-border bg-background hover:bg-muted/40",
        className,
      )}
    >
      <ThemeSwatch theme={theme} />
      <div className="min-w-0 w-full">
        <div className="truncate text-[11px] font-medium leading-tight">
          {themeDisplayLabel(theme, t)}
        </div>
        <div className="text-[10px] text-muted-foreground capitalize leading-tight">
          {themeAppearanceLabel(theme.appearance, t)}
        </div>
      </div>
    </button>
  );
}
