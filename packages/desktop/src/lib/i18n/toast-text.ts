import { createElement, type ReactElement } from "react";
import { useUiTranslation, type UiTranslator } from "./ui";

function ToastText({ format }: { format: (t: UiTranslator) => string }): string {
  return format(useUiTranslation().t);
}

/** Keep the copy reactive without opening a new notification when the locale changes. */
export function localizedToastText(format: (t: UiTranslator) => string): ReactElement {
  return createElement(ToastText, { format });
}
