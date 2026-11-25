export function localizedSearchKeywords(
  t: (key: string, defaultValue: string) => string,
  key: string,
  english: string,
): string[] {
  const translated = t(key, english);
  const original = english.split(", ");
  return translated === english ? original : [...original, ...translated.split(/[,，、]/u)];
}
