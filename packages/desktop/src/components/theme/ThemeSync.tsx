import { useThemeSync } from "@/hooks/useTheme";

/** Keep slider drafts from re-rendering the root layout and its contexts. */
export function ThemeSync(): null {
  useThemeSync();
  return null;
}
