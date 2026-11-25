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
import { NOTCH_PRIMARY_STYLE_KEY, useNotchPrefs } from "@/lib/notch/notch-prefs";
import { SettingsRow } from "./SettingsRow";

export function NotchPrimaryStyleSetting(): React.JSX.Element {
  const { t } = useUiTranslation();
  const id = useId();
  const prefs = useNotchPrefs();
  const setting = useSetting(NOTCH_PRIMARY_STYLE_KEY);
  const busy = setting.isLoading || setting.isSaving;
  const builtinOnly = prefs.displayMode === "builtin_always";

  return (
    <SettingsRow
      label={t("settings.notifications.notch.primaryStyle.label", "Primary display status")}
      htmlFor={id}
      divided
      description={
        builtinOnly
          ? t(
              "settings.notifications.notch.primaryStyle.disabledDescription",
              "Choose Both or Primary in Show notch on to customize the primary display status.",
            )
          : t(
              "settings.notifications.notch.primaryStyle.description",
              "On screens without a hardware notch, choose a thin activity strip or the built-in notch's full style. No status hides compact activity; notifications still appear. Hardware notches keep their own style.",
            )
      }
      control={
        <>
          {busy && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
          <Select
            value={prefs.primaryStyle}
            onValueChange={setting.setValue}
            disabled={busy || builtinOnly}
          >
            <SelectTrigger id={id} className="w-48" aria-busy={busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {t("settings.notifications.notch.primaryStyle.noStatus", "No status")}
              </SelectItem>
              <SelectItem value="strip_4">
                {t("settings.notifications.notch.primaryStyle.fourPixels", "4 px")}
              </SelectItem>
              <SelectItem value="strip_8">
                {t("settings.notifications.notch.primaryStyle.eightPixels", "8 px")}
              </SelectItem>
              <SelectItem value="builtin">
                {t(
                  "settings.notifications.notch.primaryStyle.builtInNotchStyle",
                  "Built-in notch style",
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </>
      }
    />
  );
}
