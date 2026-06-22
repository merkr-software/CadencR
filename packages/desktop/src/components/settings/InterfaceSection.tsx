import type { ReactNode } from "react";
import { Keyboard, ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useZoom } from "@/hooks/useZoom";
import { useShortcutsHelpStore } from "@/stores/shortcuts-help-store";
import { formatCombo } from "@/lib/shortcuts/format";
import { getRegistryShortcut } from "@/lib/shortcuts/resolve";
import { IconTile } from "./IconTile";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

// Combo is static (registry-derived), so compute its glyphs once at module load.
const HELP_COMBO = formatCombo(getRegistryShortcut("shortcuts-help").keys).join(" ");

export function InterfaceSection(): React.JSX.Element {
  const { zoomLevel, zoomIn, zoomOut, resetZoom } = useZoom();
  // Desktop and mobile keep independent zoom levels, so this control only ever
  // shows (and edits) the option for the device type it's running on.
  const isMobile = useIsMobile();
  // Action only — selecting the setter (never the open flag) keeps this row
  // from re-rendering when the modal toggles.
  const openShortcutsHelp = useShortcutsHelpStore((s) => s.setOpen);

  return (
    <SettingsSection id="interface" title="Interface & Zoom" subtitle="UI scaling for this device">
      <SettingsCard>
        <SettingsRow
          align="start"
          icon={
            <IconTile tint="cyan">
              <ZoomIn className="size-4" />
            </IconTile>
          }
          label="UI zoom"
          description={
            isMobile ? (
              "Scales the interface on this device only — separate from the desktop app's zoom."
            ) : (
              <>
                Affects sidebar, editor, terminal, and chrome together.
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Kbd>⌘ +</Kbd>
                  <Kbd>⌘ −</Kbd>
                  <Kbd>⌘ 0</Kbd>
                  work everywhere.
                </span>
              </>
            )
          }
          control={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="size-7 p-0" onClick={zoomOut}>
                −
              </Button>
              <span className="w-14 text-center text-sm tabular-nums">{zoomLevel}%</span>
              <Button variant="outline" size="sm" className="size-7 p-0" onClick={zoomIn}>
                +
              </Button>
              <Button variant="ghost" size="sm" onClick={resetZoom}>
                Reset
              </Button>
            </div>
          }
        />
        <SettingsRow
          divided
          icon={
            <IconTile tint="purple">
              <Keyboard className="size-4" />
            </IconTile>
          }
          label="Keyboard shortcuts"
          description={
            <span className="flex flex-wrap items-center gap-1.5">
              Browse every shortcut, or press
              <Kbd>{HELP_COMBO}</Kbd>
              anywhere.
            </span>
          }
          control={
            <Button variant="outline" size="sm" onClick={() => openShortcutsHelp(true)}>
              View shortcuts
            </Button>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded border border-b-2 border-border bg-card px-1.5 font-mono text-[10px] font-medium text-foreground">
      {children}
    </kbd>
  );
}
