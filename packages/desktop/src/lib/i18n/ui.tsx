import { Trans, useTranslation, type TransProps } from "react-i18next";
import { useSyncExternalStore } from "react";
import { uiI18n } from "../../shared/ui-i18n";
import { readBrowserLocale, subscribeToBrowserLanguage } from "./languages";
export { uiI18n, translateUi } from "../../shared/ui-i18n";

const uiOptions = { i18n: uiI18n };

export function useUiTranslation(locale?: string) {
  return useTranslation("ui", locale ? { ...uiOptions, lng: locale } : uiOptions);
}

export function readBrowserUiLocale(): string {
  return import.meta.env.DEV ? readBrowserLocale() : "en";
}

/** The remote sign-in screen can use the browser preference before it has a token. */
export function useBrowserUiLocale(): string {
  return useSyncExternalStore(subscribeToBrowserLanguage, readBrowserUiLocale);
}

export type UiTranslator = ReturnType<typeof useUiTranslation>["t"];

type UiTransProps = Pick<TransProps<string, "ui">, "components" | "count" | "t" | "values"> & {
  i18nKey: string;
  defaults: string;
};

export function UiTrans(props: UiTransProps) {
  return <Trans {...props} i18n={uiI18n} ns="ui" />;
}
