import { LoaderCircle, PanelRightDashed } from "lucide-react";
import { useAutoLayoutDefault } from "@/lib/auto-layout/auto-layout-mode";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/**
 * Settings → Interface row for the workspace default of the feature page's
 * auto layout mode. Each feature can still override it from the auto layout toggle
 * beside its layout menu.
 */
export function AutoLayoutDefaultSetting() {
  const { enabled, setEnabled, isBusy } = useAutoLayoutDefault();
  return (
    <SettingsSwitchRow
      divided
      icon={<PanelRightDashed className="size-4" />}
      iconTint="purple"
      label={
        <span className="inline-flex items-center gap-1.5">
          Auto layout
          {isBusy && (
            <LoaderCircle
              className="size-3.5 animate-spin"
              aria-label="Saving auto layout preference"
            />
          )}
        </span>
      }
      description="When the agent opens a page or you click a link, the Browser splits beside the agent instead of hiding it. Default for every feature; toggle it per feature with the button beside the layout menu."
      checked={enabled}
      disabled={isBusy}
      onCheckedChange={setEnabled}
    />
  );
}
