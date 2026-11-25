import { useUiTranslation } from "@/lib/i18n/ui";
import { useId } from "react";
import { LoaderCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSetting } from "@/hooks/useSetting";
import { NOTCH_DISPLAY_MODE_KEY, useNotchPrefs } from "@/lib/notch/notch-prefs";
import { SettingsRow } from "./SettingsRow";

export function NotchDisplaySetting(): React.JSX.Element {
  const { t } = useUiTranslation();
  const id = useId();
  const prefs = useNotchPrefs();
  const setting = useSetting(NOTCH_DISPLAY_MODE_KEY);
  const busy = setting.isLoading || setting.isSaving;

  return (
    <SettingsRow
      label={t("settings.notifications.notch.display.label", "Show notch on")}
      htmlFor={id}
      description={t(
        "settings.notifications.notch.display.description",
        "Built-in always uses your Mac's built-in display, or the primary display when it is disconnected. Both shows the same island on each. Primary follows your main display.",
      )}
      control={
        <>
          {busy && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
          <Select value={prefs.displayMode} onValueChange={setting.setValue} disabled={busy}>
            <SelectTrigger id={id} className="w-40" aria-busy={busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="builtin_always">
                {t("settings.notifications.notch.display.builtInAlways", "Built-in always")}
              </SelectItem>
              <SelectItem value="both">
                {t("settings.notifications.notch.display.both", "Both")}
              </SelectItem>
              <SelectItem value="primary">
                {t("settings.notifications.notch.display.primary", "Primary")}
              </SelectItem>
            </SelectContent>
          </Select>
        </>
      }
    />
  );
}
