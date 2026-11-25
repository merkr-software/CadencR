import { useUiTranslation } from "@/lib/i18n/ui";
import { useId } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettingWriter } from "@/hooks/useSetting";
import { apiErrorMessage } from "@/lib/api-errors";
import { languageNames, LANGUAGE_SETTING } from "@/lib/i18n/languages";
import { useLanguageSettingState } from "@/lib/i18n/LanguageProvider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "./SettingsRow";

export function LanguageSetting() {
  const id = useId();
  const { t } = useUiTranslation();
  const { t: tLanguage, i18n } = useTranslation("language");
  const { preference, system, loading, error } = useLanguageSettingState();
  const { setValue, isSaving } = useSettingWriter(LANGUAGE_SETTING);
  if (loading) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("settings.general.language.loading", "Loading language preference…")}
      </div>
    );
  }
  const errorMessage = error ? apiErrorMessage(error, "") : "";
  const description = error ? (
    errorMessage ? (
      <span lang="en">{errorMessage}</span>
    ) : (
      t("settings.general.language.readError", "Could not read the language setting.")
    )
  ) : (
    tLanguage("preview")
  );
  return (
    <div lang={i18n.resolvedLanguage}>
      <SettingsRow
        htmlFor={id}
        label={tLanguage("label")}
        description={description}
        control={
          <Select value={preference} onValueChange={setValue} disabled={isSaving || Boolean(error)}>
            <SelectTrigger id={id} size="sm" aria-busy={isSaving}>
              {isSaving && <Loader2 className="size-4 animate-spin" aria-hidden />}
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              lang={i18n.resolvedLanguage}
              position="popper"
              align="end"
              className="z-[60] animate-none! bg-[oklch(from_var(--popover)_l_c_h/1)]"
            >
              <SelectItem value="system">
                {tLanguage("system", { language: languageNames[system] })}
              </SelectItem>
              {Object.entries(languageNames).map(([value, name]) => (
                <SelectItem key={value} value={value}>
                  <span lang={value}>{name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </div>
  );
}
