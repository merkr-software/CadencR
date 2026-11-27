import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { LanguageSetting } from "@/components/settings/LanguageSetting";
import { Button } from "@/components/ui/button";
import { KBD_HINT_PROPS, ResolvedKbdChord } from "@/components/KbdShortcut";
import { useShowsKeyboardHints } from "@/hooks/useShowsKeyboardHints";
import { useZoom } from "@/hooks/useZoom";
import { useShortcutsHelpStore } from "@/stores/shortcuts-help-store";
import { isDesktopShell } from "@/lib/desktop-bridge";
import { CommandLineRow } from "./CommandLineRow";
import { RestartResumeToggle } from "./RestartResumeToggle";
import { WorkspaceJsonSettings } from "./SettingsJsonControls";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

/** Settings → General: the app-wide basics that belong to no single tool. */
export function GeneralPage(): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsPageSection pageId="general">
      <SettingsGroup
        id={SETTINGS_ANCHORS.interface}
        title={t("settings.general.interface.title", "Interface")}
      >
        <LanguageSetting />
        <ZoomRow />
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.keyboard}
        title={t("settings.general.keyboard.title", "Keyboard")}
      >
        <ShortcutsRow />
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.restarts}
        title={t("settings.general.restarts.title", "Restarts")}
      >
        <RestartResumeToggle />
      </SettingsGroup>
      {isDesktopShell() ? (
        <SettingsGroup
          id={SETTINGS_ANCHORS.commandLine}
          title={t("settings.general.commandLine.title", "Command line")}
        >
          <CommandLineRow />
        </SettingsGroup>
      ) : null}
      <SettingsGroup
        id={SETTINGS_ANCHORS.settingsFile}
        title={t("settings.general.advanced.title", "Advanced")}
        description={t(
          "settings.general.advanced.description",
          "Every setting on these pages is saved in one JSON file. Edit it directly for bulk changes, or to copy a setup to another machine.",
        )}
      >
        <SettingsSubsection>
          <WorkspaceJsonSettings />
        </SettingsSubsection>
      </SettingsGroup>
    </SettingsPageSection>
  );
}

function ZoomRow(): React.JSX.Element {
  const { t } = useUiTranslation();
  // Desktop and mobile keep independent zoom levels, so this control only ever
  // shows (and edits) the option for the device type it's running on.
  const { device, zoomLevel, step } = useZoom();
  return (
    <SettingsRow
      align="start"
      label={t("settings.general.zoom.label", "UI zoom")}
      description={
        device === "mobile" ? (
          t(
            "settings.general.zoom.mobileDescription",
            "Scales the interface on this device only. This is separate from the desktop app's zoom.",
          )
        ) : (
          <>
            {t(
              "settings.general.zoom.desktopDescription",
              "Scales the sidebar, editor, terminal and chrome together.",
            )}
            <span {...KBD_HINT_PROPS} className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <UiTrans
                i18nKey="settings.general.zoom.shortcutHint"
                defaults="<zoomIn/> <zoomOut/> <zoomReset/> work everywhere."
                components={{
                  zoomIn: <ResolvedKbdChord shortcutId="zoom-in" />,
                  zoomOut: <ResolvedKbdChord shortcutId="zoom-out" />,
                  zoomReset: <ResolvedKbdChord shortcutId="zoom-reset" />,
                }}
              />
            </span>
          </>
        )
      }
      control={
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="size-7 p-0"
            onClick={() => step("out")}
            aria-label={t("settings.general.zoom.out", "Zoom out")}
          >
            −
          </Button>
          <output aria-live="polite" className="w-12 text-center text-sm tabular-nums">
            {t("settings.general.zoom.level", "{{value}}%", { value: zoomLevel })}
          </output>
          <Button
            variant="outline"
            size="sm"
            className="size-7 p-0"
            onClick={() => step("in")}
            aria-label={t("settings.general.zoom.in", "Zoom in")}
          >
            +
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => step("reset")}
            disabled={zoomLevel === 100}
          >
            {t("settings.general.zoom.reset", "Reset")}
          </Button>
        </div>
      }
    />
  );
}

function ShortcutsRow(): React.JSX.Element {
  const { t } = useUiTranslation();
  const showsKeys = useShowsKeyboardHints();
  // Action only — selecting the setter (never the open flag) keeps this row
  // from re-rendering when the modal toggles.
  const openShortcutsHelp = useShortcutsHelpStore((s) => s.setOpen);
  return (
    <SettingsRow
      label={t("settings.general.keyboard.shortcuts", "Keyboard shortcuts")}
      description={
        showsKeys ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <UiTrans
              i18nKey="settings.general.keyboard.description"
              defaults="Browse every shortcut, or press <shortcut/> anywhere."
              components={{ shortcut: <ResolvedKbdChord shortcutId="shortcuts-help" /> }}
            />
          </span>
        ) : (
          t("settings.general.keyboard.descriptionTouch", "Browse every shortcut.")
        )
      }
      control={
        <Button variant="outline" size="sm" onClick={() => openShortcutsHelp(true)}>
          {t("settings.general.keyboard.view", "View shortcuts")}
        </Button>
      }
    />
  );
}
