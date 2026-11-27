import { useUiTranslation } from "@/lib/i18n/ui";
import { useId } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";
import { languageOptions, languagePreference } from "@/lib/i18n/languages";
import { useSaveInterfaceLanguage } from "@/lib/i18n/useSaveInterfaceLanguage";
import { useLanguageSettingState } from "@/lib/i18n/LanguageProvider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsRow } from "./SettingsRow";
import brFlag from "../../../assets/flags/br.svg?no-inline";
import deFlag from "../../../assets/flags/de.svg?no-inline";
import esFlag from "../../../assets/flags/es.svg?no-inline";
import frFlag from "../../../assets/flags/fr.svg?no-inline";
import jpFlag from "../../../assets/flags/jp.svg?no-inline";
import usFlag from "../../../assets/flags/us.svg?no-inline";

const flagSources = {
  br: brFlag,
  de: deFlag,
  es: esFlag,
  fr: frFlag,
  jp: jpFlag,
  us: usFlag,
};

export function LanguageSetting() {
  const id = useId();
  const { t } = useUiTranslation();
  const { t: tLanguage, i18n } = useTranslation("language");
  const { preference, system, loading, applying, error, loadError, retry } =
    useLanguageSettingState();
  const { save, busy: saving } = useSaveInterfaceLanguage(system);
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
  const description = errorMessage ? (
    <span lang="en-US">{errorMessage}</span>
  ) : error ? (
    t("settings.general.language.readError", "Could not read the language setting.")
  ) : (
    loadError?.message
  );
  const busy = saving || applying;
  return (
    <div lang={i18n.resolvedLanguage}>
      <SettingsRow
        htmlFor={id}
        label={tLanguage("label")}
        description={description}
        control={
          <>
            {(Boolean(error) || loadError) && (
              <Button variant="outline" size="sm" onClick={retry}>
                {t("common.retry", "Retry")}
              </Button>
            )}
            <Select
              value={preference}
              onValueChange={(value) => void save(languagePreference(value))}
              disabled={busy || Boolean(error)}
            >
              <SelectTrigger id={id} size="sm" aria-busy={busy}>
                {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                lang={i18n.resolvedLanguage}
                position="popper"
                align="end"
                className="z-[60] animate-none! bg-[oklch(from_var(--popover)_l_c_h/1)]"
              >
                <SelectItem value="system">
                  {tLanguage("system", { language: languageOptions[system].name })}
                </SelectItem>
                {Object.entries(languageOptions).map(([value, { name, region, flag }]) => (
                  <SelectItem key={value} value={value}>
                    <span className="inline-flex items-center gap-2" lang={value}>
                      <img
                        src={flagSources[flag]}
                        alt=""
                        aria-hidden="true"
                        width={20}
                        height={15}
                        className="shrink-0 rounded-xs"
                      />
                      <span>{`${name} (${region})`}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
    </div>
  );
}
