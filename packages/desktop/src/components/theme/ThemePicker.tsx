import { useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ThemeCard } from "./ThemeCard";
import { type ThemeDefinition, type ThemeId } from "@/lib/themes";

/**
 * Full-width horizontal carousel of theme cards. Cards lay out in a single
 * scrollable row; chevron buttons scroll by a viewport, and the radiogroup
 * handles ArrowLeft / ArrowRight for keyboard navigation (which also live-
 * applies the theme so the user sees the change behind the drawer).
 */
interface ThemePickerProps {
  title: string;
  /** Built-ins plus the user's enabled themes, in display order. */
  themes: ThemeDefinition[];
  selectedThemeId: ThemeId;
  onSelect: (id: ThemeId) => void;
  disabled: boolean;
  /** If true, the currently selected card is focused on mount. */
  autoFocus?: boolean;
}

function useSelectedThemeFocus(
  scrollerRef: RefObject<HTMLDivElement | null>,
  selectedThemeId: ThemeId,
  themes: ThemeDefinition[],
  selectedIndex: number,
  autoFocus: boolean,
): void {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const target = scroller.querySelector<HTMLElement>(`[data-theme-card="${selectedThemeId}"]`);
    target?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    // Keyed on the selected *id*, not the array: the list gets a new identity
    // whenever a theme file changes, and re-running would smooth-scroll the
    // carousel for an edit that didn't move the selection.
  }, [scrollerRef, selectedThemeId]);

  useEffect(() => {
    if (!autoFocus) return;
    const target = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-theme-card="${themes[selectedIndex]?.id}"]`,
    );
    target?.focus({ preventScroll: true });
    // The selected card should only autofocus when the picker mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function ThemePicker({
  title,
  themes,
  selectedThemeId,
  onSelect,
  disabled,
  autoFocus = false,
}: ThemePickerProps): React.JSX.Element {
  const { t } = useUiTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const selectedIndex = useMemo(
    () =>
      Math.max(
        0,
        themes.findIndex((t) => t.id === selectedThemeId),
      ),
    [themes, selectedThemeId],
  );

  useSelectedThemeFocus(scrollerRef, selectedThemeId, themes, selectedIndex, autoFocus);

  const step = useCallback(
    (direction: 1 | -1): void => {
      if (disabled) return;
      const nextIndex = (selectedIndex + direction + themes.length) % themes.length;
      const next = themes[nextIndex];
      if (!next) return;
      onSelect(next.id);
      // Move focus to the new card so subsequent arrows continue to work.
      requestAnimationFrame(() => {
        const card = scrollerRef.current?.querySelector<HTMLElement>(
          `[data-theme-card="${next.id}"]`,
        );
        card?.focus({ preventScroll: true });
      });
    },
    [disabled, onSelect, selectedIndex, themes],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      step(e.key === "ArrowRight" ? 1 : -1);
    },
    [step],
  );

  return (
    <section className="space-y-2" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="relative">
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label={t("appearance.theme.previous", "Previous {{title}}", { title })}
          disabled={disabled}
          onClick={() => step(-1)}
          className="absolute left-0 top-1/2 z-10 -translate-y-1/2 shadow-md"
        >
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label={t("appearance.theme.next", "Next {{title}}", { title })}
          disabled={disabled}
          onClick={() => step(1)}
          className="absolute right-0 top-1/2 z-10 -translate-y-1/2 shadow-md"
        >
          <ChevronRight />
        </Button>
        <div
          ref={scrollerRef}
          role="radiogroup"
          aria-label={title}
          onKeyDown={handleKeyDown}
          className={cn(
            "flex w-full flex-nowrap gap-2 overflow-x-auto scroll-smooth px-8 py-1",
            "[scrollbar-width:thin]",
          )}
        >
          {themes.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              selected={theme.id === selectedThemeId}
              disabled={disabled}
              tabIndex={theme.id === selectedThemeId ? 0 : -1}
              onSelect={() => onSelect(theme.id)}
              className="w-24 shrink-0 snap-start p-1.5"
            />
          ))}
        </div>
      </div>
    </section>
  );
}
