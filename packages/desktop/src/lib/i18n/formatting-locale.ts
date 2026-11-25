const systemLocale = new Intl.NumberFormat().resolvedOptions().locale;

/** Release builds keep the system's regional formats while UI language selection is in preview. */
export function formattingLocale(interfaceLanguage: string): string {
  return import.meta.env.DEV && interfaceLanguage && interfaceLanguage !== "cimode"
    ? interfaceLanguage
    : systemLocale;
}
