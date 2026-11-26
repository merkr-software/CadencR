export const LANGUAGE_SETTING = "ui_language";
export const DEFAULT_LANGUAGE = "en-US";

export const languageOptions = {
  "en-US": { name: "English", region: "United States", flag: "us" },
  "es-ES": { name: "Español", region: "España", flag: "es" },
  "de-DE": { name: "Deutsch", region: "Deutschland", flag: "de" },
  "ja-JP": { name: "日本語", region: "日本", flag: "jp" },
  "fr-FR": { name: "Français", region: "France", flag: "fr" },
  "pt-BR": { name: "Português", region: "Brasil", flag: "br" },
} as const;

export type Language = keyof typeof languageOptions;

export const catalogByLanguage: Readonly<Record<string, Language>> = {
  en: DEFAULT_LANGUAGE,
  es: "es-ES",
  de: "de-DE",
  ja: "ja-JP",
  fr: "fr-FR",
  pt: "pt-BR",
};

function matchCatalog(locale: string): Language | undefined {
  const [base] = locale.toLowerCase().split("-");
  return Object.hasOwn(catalogByLanguage, base) ? catalogByLanguage[base] : undefined;
}

/** Electron on Linux may supply POSIX locale names alongside BCP 47 tags. */
export function supportedLocale(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tag = value.trim().split(/[.@]/, 1)[0].replaceAll("_", "-");
  const catalog = matchCatalog(tag);
  if (!catalog) return undefined;

  try {
    const [locale] = Intl.getCanonicalLocales(tag);
    return locale?.includes("-") ? locale : catalog;
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

export function catalogLanguage(locale: string): Language {
  return matchCatalog(locale) ?? DEFAULT_LANGUAGE;
}

export function languagePreference(value: string | null | undefined): Language | "system" {
  const locale = supportedLocale(value);
  return locale ? catalogLanguage(locale) : "system";
}

/** Retain the selected system tag for formats even when its catalog is shared. */
export function matchSystemLocale(preferences: readonly string[]): string {
  for (const preference of preferences) {
    const locale = supportedLocale(preference);
    if (locale) return locale;
  }
  return DEFAULT_LANGUAGE;
}

export function readBrowserLocale(): string {
  if (typeof navigator === "undefined") return DEFAULT_LANGUAGE;
  return matchSystemLocale(
    navigator.languages?.length ? navigator.languages : [navigator.language],
  );
}

export function subscribeToBrowserLanguage(notify: () => void): () => void {
  window.addEventListener("languagechange", notify);
  return () => window.removeEventListener("languagechange", notify);
}
