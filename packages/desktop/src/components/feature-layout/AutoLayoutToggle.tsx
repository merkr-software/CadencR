import { useUiTranslation } from "@/lib/i18n/ui";
import { type ReactNode } from "react";
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

/** Length of the ring's one-shot animation (`auto-layout-pulse` in auto-layout.css). */
const PULSE_DURATION_MS = 1_100;

/**
 * On/off switch for the feature's auto layout mode, beside the layout menu.
 * Each time auto layout rearranges the panes the button pulses once, so the
 * change reads as the mode's doing rather than a glitch.
 */
export function AutoLayoutToggle({ featureId }: { featureId: number }): ReactNode {
  const { t } = useUiTranslation();
  const { active, isLoading, error, isSaving, setActive } = useAutoLayoutMode(featureId);
  const pulsedAt = useAutoLayoutStore((s) => s.pulsedAt[featureId] ?? 0);
  // The button remounts on every feature switch, undo or reset — and on the
  // very restructure that pulses it. Only a pulse still within its animation
  // plays, so a remount later doesn't credit auto layout with the user's own
  // change. (Read here, not in the selector: a time-dependent selector would
  // return a different snapshot on every call.)
  const pulsing = Date.now() - pulsedAt < PULSE_DURATION_MS;
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
    ? t("workspace.tools.autoLayoutToggle.unavailable", "Auto layout unavailable: {{message}}", {
        message: apiErrorMessage(
          error,
          t(
            "workspace.tools.autoLayoutToggle.settingUnavailable",
            "its setting could not be loaded",
          ),
        ),
      })
    : active
      ? t(
          "workspace.tools.autoLayoutToggle.autoLayoutOnOpenedPagesSplitBeside",
          "Auto layout on: opened pages split beside the agent",
        )
      : t("workspace.tools.autoLayoutToggle.autoLayoutOff", "Auto layout off");

  return (
    <ShortcutTooltip label={label} keys={formatCombo(keys)} alignRight>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("workspace.tools.autoLayoutToggle.autoLayout", "Auto layout")}
        aria-pressed={active}
        data-state={active ? "on" : "off"}
        disabled={busy}
        onClick={() => setActive(!active)}
        className={cn(
          "relative size-7",
          active && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
        )}
      >
        {/* Keyed by the pulse time: a new key remounts the ring, replaying
            its one-shot animation; it rests invisible afterwards. */}
        {pulsing && <span key={pulsedAt} aria-hidden className="auto-layout-pulse" />}
        {failed ? (
          <TriangleAlertIcon className="size-4 text-destructive" />
        ) : isSaving ? (
          <LoaderCircleIcon
            className="size-4 animate-spin"
            aria-label={t(
              "workspace.tools.autoLayoutToggle.savingAutoLayout",
              "Saving auto layout",
            )}
          />
        ) : (
          <PanelRightDashedIcon className="size-4" />
        )}
      </Button>
    </ShortcutTooltip>
  );
}
