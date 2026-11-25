export const LANGUAGE_SETTING = "ui_language";
export const languageNames = { en: "English", fr: "Français" } as const;
export type Language = keyof typeof languageNames;

function isLanguage(value: string): value is Language {
  return Object.hasOwn(languageNames, value);
}

export function languagePreference(value: string | null | undefined): Language | "system" {
  return value && isLanguage(value) ? value : "system";
}

/** Electron on Linux may supply POSIX locale names alongside BCP 47 tags. */
export function matchSystemLanguage(preferences: readonly string[]): Language {
  for (const preference of preferences) {
    const tag = preference.split(/[.@]/, 1)[0].replaceAll("_", "-").toLowerCase();
    if (isLanguage(tag)) return tag;
    const [base] = tag.split("-");
    if (isLanguage(base)) return base;
  }
  return "en";
}
