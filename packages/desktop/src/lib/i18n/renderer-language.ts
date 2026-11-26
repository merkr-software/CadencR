import { getRuntimeConfigSync } from "@/api/client";
import { toastError } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { translateUi } from "@/shared/ui-i18n";
import { matchSystemLocale, readBrowserLocale } from "./languages";

export function readSystemLocale(): string {
  const preferredLanguages = getRuntimeConfigSync().preferredLanguages;
  return preferredLanguages ? matchSystemLocale(preferredLanguages) : readBrowserLocale();
}

export async function syncNativeLanguage(locale: string): Promise<void> {
  await desktopBridge.setInterfaceLanguage(locale).catch((error: unknown) => {
    toastError(
      error,
      translateUi("shell.language.nativeError", "Could not update the native menu language"),
    );
  });
}
