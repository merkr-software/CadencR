const systemLocale = new Intl.NumberFormat().resolvedOptions().locale;

/** System preferences provide their regional tag. Explicit preferences use the selected catalog's tag. */
export function formattingLocale(interfaceLanguage: string): string {
  return interfaceLanguage && interfaceLanguage !== "cimode" ? interfaceLanguage : systemLocale;
}
