import { Button } from "@/components/ui/button";
import { ResolvedKbdChord } from "@/components/KbdShortcut";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useZoom } from "@/hooks/useZoom";
import { useShortcutsHelpStore } from "@/stores/shortcuts-help-store";
import { RestartResumeToggle } from "./RestartResumeToggle";
import { WorkspaceJsonSettings } from "./SettingsJsonControls";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

/** Settings → General: the app-wide basics that belong to no single tool. */
export function GeneralPage(): React.JSX.Element {
  return (
    <SettingsPageSection pageId="general">
      <SettingsGroup id={SETTINGS_ANCHORS.interface} title="Interface">
        <ZoomRow />
      </SettingsGroup>
      <SettingsGroup id={SETTINGS_ANCHORS.keyboard} title="Keyboard">
        <ShortcutsRow />
      </SettingsGroup>
      <SettingsGroup id={SETTINGS_ANCHORS.restarts} title="Restarts">
        <RestartResumeToggle />
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.settingsFile}
        title="Advanced"
        description="Every setting on these pages is saved in one JSON file. Edit it directly for bulk changes, or to copy a setup to another machine."
      >
        <SettingsSubsection>
          <WorkspaceJsonSettings />
        </SettingsSubsection>
      </SettingsGroup>
    </SettingsPageSection>
  );
}

function ZoomRow(): React.JSX.Element {
  const { zoomLevel, zoomIn, zoomOut, resetZoom } = useZoom();
  // Desktop and mobile keep independent zoom levels, so this control only ever
  // shows (and edits) the option for the device type it's running on.
  const isMobile = useIsMobile();
  return (
    <SettingsRow
      align="start"
      label="UI zoom"
      description={
        isMobile ? (
          "Scales the interface on this device only. This is separate from the desktop app's zoom."
        ) : (
          <>
            Scales the sidebar, editor, terminal and chrome together.
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <ResolvedKbdChord shortcutId="zoom-in" />
              <ResolvedKbdChord shortcutId="zoom-out" />
              <ResolvedKbdChord shortcutId="zoom-reset" />
              work everywhere.
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
            onClick={zoomOut}
            aria-label="Zoom out"
          >
            −
          </Button>
          <output aria-live="polite" className="w-12 text-center text-sm tabular-nums">
            {zoomLevel}%
          </output>
          <Button
            variant="outline"
            size="sm"
            className="size-7 p-0"
            onClick={zoomIn}
            aria-label="Zoom in"
          >
            +
          </Button>
          <Button variant="ghost" size="sm" onClick={resetZoom} disabled={zoomLevel === 100}>
            Reset
          </Button>
        </div>
      }
    />
  );
}

function ShortcutsRow(): React.JSX.Element {
  // Action only — selecting the setter (never the open flag) keeps this row
  // from re-rendering when the modal toggles.
  const openShortcutsHelp = useShortcutsHelpStore((s) => s.setOpen);
  return (
    <SettingsRow
      label="Keyboard shortcuts"
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          Browse every shortcut, or press
          <ResolvedKbdChord shortcutId="shortcuts-help" />
          anywhere.
        </span>
      }
      control={
        <Button variant="outline" size="sm" onClick={() => openShortcutsHelp(true)}>
          View shortcuts
        </Button>
      }
    />
  );
}
