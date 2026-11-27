import { useUiTranslation } from "@/lib/i18n/ui";
import { LoaderCircle } from "lucide-react";
import { useAutoLayoutDefault } from "@/lib/auto-layout/auto-layout-mode";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/**
 * Settings → Browser → Layout row for the workspace default of the feature page's
 * auto layout mode. Each feature can still override it from the auto layout toggle
 * beside its layout menu.
 */
export function AutoLayoutDefaultSetting() {
  const { t } = useUiTranslation();
  const { enabled, setEnabled, isBusy } = useAutoLayoutDefault();
  return (
    <SettingsSwitchRow
      label={
        <span className="inline-flex items-center gap-1.5">
          {t("workspace.tools.autoLayoutDefaultSetting.autoLayout", "Auto layout")}
          {isBusy && (
            <LoaderCircle
              className="size-3.5 animate-spin"
              aria-label={t(
                "workspace.tools.autoLayoutDefaultSetting.savingAutoLayoutPreference",
                "Saving auto layout preference",
              )}
            />
          )}
        </span>
      }
      description={t(
        "workspace.tools.autoLayoutDefaultSetting.whenTheAgentOpensAPageOr",
        "When the agent opens a page or you click a link, the Browser splits beside the agent instead of hiding it. Default for every feature; toggle it per feature with the button beside the layout menu.",
      )}
      checked={enabled}
      disabled={isBusy}
      onCheckedChange={setEnabled}
    />
  );
}
