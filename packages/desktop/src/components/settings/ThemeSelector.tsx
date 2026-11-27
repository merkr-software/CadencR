import { useUiTranslation } from "@/lib/i18n/ui";
import { useNavigate } from "@tanstack/react-router";
import { Paintbrush } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/useTheme";
import { getTheme } from "@/lib/themes";
import { themeAppearanceLabel, themeDisplayLabel } from "@/lib/themes/display";
import { useLastScreenStore } from "@/stores/last-screen-store";
import { THEME_SELECTOR_SEARCH_KEY } from "@/components/theme/ThemeDrawer";
import { SettingsRow } from "./SettingsRow";

/**
 * Settings entry-point for the theme picker.
 *
 * The picker UI itself lives in the global `ThemeDrawer` (rendered from
 * `RootOverlays`) so the user sees each pick on the live UI of the
 * screen they were just on (unified agent / feature / session). Drawer open
 * state is encoded as `?theme-selector=true` in the URL — keeping it in URL
 * state means no extra store, and the drawer can be opened from anywhere.
 */
export function ThemeSelector(): React.JSX.Element {
  const { t } = useUiTranslation();
  const navigate = useNavigate();
  const { themeId, isLoading } = useTheme();
  const activeTheme = getTheme(themeId);

  const handleClick = (): void => {
    const lastScreen = useLastScreenStore.getState().lastScreen;
    // Replay the exact pathname + search we captured so routes that require
    // params (e.g. `/ws-session/$sessionId` needs `cwd`/`featureId`/`projectId`)
    // don't throw. Then add `theme-selector=true` to open the drawer.
    const pathname = lastScreen?.pathname ?? "/";
    const search = {
      ...lastScreen?.search,
      [THEME_SELECTOR_SEARCH_KEY]: true as const,
    };
    void navigate({ to: pathname, search });
  };

  return (
    <SettingsRow
      label={t("appearance.theme.label", "Theme")}
      description={
        isLoading
          ? t("appearance.theme.loadingCurrent", "Loading current theme…")
          : t(
              "appearance.theme.current",
              "Currently {{theme}} ({{appearance}}). Opens the picker over your last screen.",
              {
                theme: themeDisplayLabel(activeTheme, t),
                appearance: themeAppearanceLabel(activeTheme.appearance, t),
              },
            )
      }
      control={
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1"
          onClick={handleClick}
          disabled={isLoading}
        >
          <Paintbrush />
          {t("appearance.theme.change", "Change theme")}
        </Button>
      }
    />
  );
}
