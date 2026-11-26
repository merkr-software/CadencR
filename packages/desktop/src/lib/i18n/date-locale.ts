import { de } from "react-day-picker/locale/de";
import { enCA } from "react-day-picker/locale/en-CA";
import { enGB } from "react-day-picker/locale/en-GB";
import { enUS } from "react-day-picker/locale/en-US";
import { es } from "react-day-picker/locale/es";
import { frCA } from "react-day-picker/locale/fr-CA";
import { fr } from "react-day-picker/locale/fr";
import { ja } from "react-day-picker/locale/ja";
import { pt } from "react-day-picker/locale/pt";
import { ptBR } from "react-day-picker/locale/pt-BR";
import { catalogLanguage, type Language } from "./languages";

// DayPicker extends the date-fns locales with accessible calendar labels.
const catalogLocales = {
  "en-US": enUS,
  "es-ES": es,
  "de-DE": de,
  "ja-JP": ja,
  "fr-FR": fr,
  "pt-BR": ptBR,
} satisfies Record<Language, typeof fr>;

export function dateLocale(language: string) {
  switch (language) {
    case "en-CA":
      return enCA;
    case "en-GB":
      return enGB;
    case "fr-CA":
      return frCA;
    case "pt-PT":
      return pt;
    default:
      return catalogLocales[catalogLanguage(language)];
  }
}
