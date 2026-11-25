export const LANGUAGE_SETTING = "ui_language";
export const languageNames = { en: "English", fr: "Français" } as const;
export type Language = keyof typeof languageNames;

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && Object.hasOwn(languageNames, value);
}

export function languagePreference(value: string | null | undefined): Language | "system" {
  return value && isLanguage(value) ? value : "system";
}

/** Electron on Linux may supply POSIX locale names alongside BCP 47 tags. */
export function matchSystemLocale(preferences: readonly string[]): string {
  for (const preference of preferences) {
    const tag = preference.split(/[.@]/, 1)[0].replaceAll("_", "-").toLowerCase();
    const [base] = tag.split("-");
    if (!isLanguage(base)) continue;
    try {
      return Intl.getCanonicalLocales(tag)[0] ?? base;
    } catch (error) {
      if (error instanceof RangeError) return base;
      throw error;
    }
  }
  return "en";
}

export function readBrowserLocale(): string {
  if (typeof navigator === "undefined") return "en";
  return matchSystemLocale(
    navigator.languages?.length ? navigator.languages : [navigator.language],
  );
}

export function subscribeToBrowserLanguage(notify: () => void): () => void {
  window.addEventListener("languagechange", notify);
  return () => window.removeEventListener("languagechange", notify);
}
