import { useState, type ReactNode } from "react";
import { LoaderCircleIcon, PanelRightDashedIcon, TriangleAlertIcon } from "lucide-react";

import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { useShortcut } from "@/hooks/useShortcut";
import { apiErrorMessage } from "@/lib/api-errors";
import { useAutoLayoutMode } from "@/lib/auto-layout/auto-layout-mode";
import { formatCombo } from "@/lib/shortcuts/format";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";
import { cn } from "@/lib/utils";
import { useAutoLayoutStore } from "@/stores/auto-layout-store";

import { useFeatureLayoutContext } from "./FeatureLayoutContext";

/**
 * On/off switch for the feature's auto layout mode, beside the layout menu.
 * Each time auto layout rearranges the panes the button pulses once, so the
 * change reads as the mode's doing rather than a glitch.
 */
export function AutoLayoutToggle({ featureId }: { featureId: number }): ReactNode {
  const { active, isLoading, error, isSaving, setActive } = useAutoLayoutMode(featureId);
  const pulse = useAutoLayoutStore((s) => s.pulse[featureId] ?? 0);
  // The count outlives this button: it remounts on every feature switch, undo
  // or reset, and replaying the last ring then would credit auto layout with
  // the user's own change. Only reveals made while mounted pulse.
  const [pulseAtMount] = useState(pulse);
  const hotkeysEnabled = useFeatureLayoutContext()?.hotkeysEnabled ?? true;
  const { keys } = useResolvedShortcut("layout-auto-toggle");
  const failed = error !== null;
  const busy = isLoading || isSaving || failed;
  useShortcut(
    "layout-auto-toggle",
    (event) => {
      event.preventDefault();
      if (!busy) setActive(!active);
    },
    { enabled: hotkeysEnabled },
  );
  const label = failed
    ? `Auto layout unavailable: ${apiErrorMessage(error, "its setting could not be loaded")}`
    : active
      ? "Auto layout on: opened pages split beside the agent"
      : "Auto layout off";

  return (
    <ShortcutTooltip label={label} keys={formatCombo(keys)} alignRight>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Auto layout"
        aria-pressed={active}
        data-state={active ? "on" : "off"}
        disabled={busy}
        onClick={() => setActive(!active)}
        className={cn(
          "relative size-7",
          active && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
        )}
      >
        {/* Keyed by the pulse count: a new key remounts the ring, replaying
            its one-shot animation; it rests invisible afterwards. */}
        {pulse > pulseAtMount && <span key={pulse} aria-hidden className="auto-layout-pulse" />}
        {failed ? (
          <TriangleAlertIcon className="size-4 text-destructive" />
        ) : isSaving ? (
          <LoaderCircleIcon className="size-4 animate-spin" aria-label="Saving auto layout" />
        ) : (
          <PanelRightDashedIcon className="size-4" />
        )}
      </Button>
    </ShortcutTooltip>
  );
}
