import { memo, useCallback, useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { LoaderCircle, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/useTheme";
import { allThemes } from "@/lib/themes";
import { HaloControls } from "@/components/theme/HaloControls";
import { ThemePicker } from "@/components/theme/ThemePicker";
import { cn } from "@/lib/utils";

/**
 * Global floating theme drawer. Rendered once from `RootOverlays`, opened by
 * adding `?theme-selector=true` to the URL (the **Change theme** button in
 * `/settings` does that after navigating back to the user's last screen).
 *
 * Non-modal by design: no backdrop, no outside-click dismissal. The whole
 * point is to see each saved pick on the live UI of whichever screen the user
 * was on, so the rest of the app stays fully interactive.
 *
 * Dismissed via the X button or Escape — both strip the search param.
 */
export const THEME_SELECTOR_SEARCH_KEY = "theme-selector";

function ThemeDrawerImpl(): React.JSX.Element | null {
  const navigate = useNavigate();
  const isOpen = useRouterState({
    select: (s) =>
      (s.location.search as Record<string, unknown> | undefined)?.[THEME_SELECTOR_SEARCH_KEY] ===
      true,
  });

  const close = useCallback((): void => {
    void navigate({
      to: ".",
      search: (prev) => {
        const next = { ...(prev as Record<string, unknown>) };
        delete next[THEME_SELECTOR_SEARCH_KEY];
        return next;
      },
    });
  }, [navigate]);

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, close]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Change theme"
      className={cn(
        // Anchored bottom-left and floated above the left sidebar.
        "fixed bottom-4 left-4 z-50 w-[min(calc(100vw-2rem),22rem)]",
        "rounded-xl border border-border bg-popover text-popover-foreground",
        "shadow-2xl shadow-black/40",
        "animate-in fade-in-0 slide-in-from-bottom-4 duration-200 ease-out",
      )}
    >
      <ThemeDrawerContent onClose={close} />
    </div>
  );
}

function ThemeDrawerContent({ onClose }: { onClose: () => void }): React.JSX.Element {
  const {
    theme,
    manualThemeId,
    systemLightThemeId,
    systemDarkThemeId,
    followSystemTheme,
    setTheme,
    setFollowSystemTheme,
    setSystemLightTheme,
    setSystemDarkTheme,
    isLoading,
    isSaving,
  } = useTheme();
  // Built-ins plus the user's registered themes — the picker makes no
  // distinction, which is the point of the theme library: a theme you wrote sits
  // alongside the shipped ones. Read from the registry rather than the query so
  // the list can only offer themes `getTheme` can actually resolve; `useTheme`
  // above subscribes to it, so this re-renders when it changes.
  const themes = allThemes();
  const followSystemId = "theme-drawer-follow-system";

  return (
    <div className="flex max-h-[min(70vh,40rem)] flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
        <div className="min-w-0 space-y-0.5">
          {/* The theme applies once the backend confirms it; the spinner covers the wait. */}
          <h2 className="flex items-center gap-1.5 text-sm font-semibold" aria-busy={isSaving}>
            Change theme
            {isSaving && (
              <LoaderCircle aria-label="Saving theme" className="size-3.5 animate-spin" />
            )}
          </h2>
          <p className="text-xs text-muted-foreground">
            Your pick is saved, then shown on the screen behind this panel.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close theme picker"
          title="Close (Esc)"
        >
          <X />
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-background px-4 py-3">
          <span className="space-y-1">
            <label htmlFor={followSystemId} className="block text-sm font-medium">
              Follow system theme
            </label>
            <span className="block text-xs text-muted-foreground">
              Switch automatically when your OS changes between light and dark mode.
            </span>
          </span>
          <Switch
            id={followSystemId}
            checked={followSystemTheme}
            disabled={isLoading || isSaving}
            onCheckedChange={setFollowSystemTheme}
          />
        </div>

        {followSystemTheme ? (
          <div className="space-y-5">
            <ThemePicker
              themes={themes}
              title="Light system theme"
              selectedThemeId={systemLightThemeId}
              onSelect={setSystemLightTheme}
              disabled={isLoading}
              autoFocus
            />
            <ThemePicker
              themes={themes}
              title="Dark system theme"
              selectedThemeId={systemDarkThemeId}
              onSelect={setSystemDarkTheme}
              disabled={isLoading}
            />
          </div>
        ) : (
          <ThemePicker
            themes={themes}
            title="All UI theme"
            selectedThemeId={manualThemeId}
            onSelect={setTheme}
            disabled={isLoading}
            autoFocus
          />
        )}

        <HaloControls theme={theme} isLoading={isLoading} />
      </div>
    </div>
  );
}

export const ThemeDrawer = memo(ThemeDrawerImpl);
