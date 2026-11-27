import { useLayoutEffect, useSyncExternalStore } from "react";
import { toastError } from "@/lib/api-errors";
import { changeUiLanguage, uiI18n } from "@/shared/ui-i18n";
import { DEFAULT_LANGUAGE, readBrowserLocale, subscribeToBrowserLanguage } from "./languages";

export async function applyRendererLanguage(locale: string): Promise<void> {
  try {
    await changeUiLanguage(locale);
  } finally {
    document.documentElement.lang = uiI18n.resolvedLanguage ?? DEFAULT_LANGUAGE;
  }
}

/** The remote sign-in screen follows the browser before it has a workspace preference. */
export function useBrowserInterfaceLanguage(): void {
  const locale = useSyncExternalStore(subscribeToBrowserLanguage, readBrowserLocale);
  useLayoutEffect(() => {
    let current = true;
    void applyRendererLanguage(locale).catch((error: unknown) => {
      if (current) toastError(error, "");
    });
    return () => {
      current = false;
    };
  }, [locale]);
}
