import { createInstance } from "i18next";
import en from "../lib/i18n/catalogs/en.json";
import fr from "../lib/i18n/catalogs/fr.json";
import type { Language } from "../lib/i18n/languages";

const previewResources = { en: { language: en }, fr: { language: fr } } satisfies Record<
  Language,
  { language: typeof en }
>;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "ui";
    resources: typeof previewResources.en & { ui: Record<string, string> };
  }
}

/** Each Electron process has its own instance; the renderer sends its resolved language to native menus. */
export const uiI18n = createInstance();
void uiI18n.init({
  lng: "en",
  fallbackLng: "en",
  ns: ["ui", "language"],
  defaultNS: "ui",
  resources: import.meta.env.DEV ? previewResources : {},
  initAsync: false,
  interpolation: { escapeValue: false },
});

export const translateUi = uiI18n.getFixedT(null, "ui");
