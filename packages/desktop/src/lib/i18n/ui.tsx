import { createInstance } from "i18next";
import { Trans, useTranslation, type TransProps } from "react-i18next";
import en from "./catalogs/en.json";
import fr from "./catalogs/fr.json";
import type { Language } from "./languages";

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

/** Also used outside React, for example when an asynchronous action raises a toast. */
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

const uiOptions = { i18n: uiI18n };

export function useUiTranslation() {
  return useTranslation("ui", uiOptions);
}

type UiTransProps = Pick<TransProps<string, "ui">, "components" | "count" | "values"> & {
  i18nKey: string;
  defaults: string;
};

export function UiTrans(props: UiTransProps) {
  return <Trans {...props} i18n={uiI18n} ns="ui" />;
}
