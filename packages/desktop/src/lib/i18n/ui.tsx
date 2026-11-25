import { Trans, useTranslation, type TransProps } from "react-i18next";
import { uiI18n } from "../../shared/ui-i18n";
export { uiI18n, translateUi } from "../../shared/ui-i18n";

const uiOptions = { i18n: uiI18n };

export function useUiTranslation() {
  return useTranslation("ui", uiOptions);
}

export type UiTranslator = ReturnType<typeof useUiTranslation>["t"];

type UiTransProps = Pick<TransProps<string, "ui">, "components" | "count" | "values"> & {
  i18nKey: string;
  defaults: string;
};

export function UiTrans(props: UiTransProps) {
  return <Trans {...props} i18n={uiI18n} ns="ui" />;
}
