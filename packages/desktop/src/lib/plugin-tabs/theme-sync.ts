import { themeToCss } from "@cadencr/tab-sdk";
import type { ThemeSnapshot } from "@cadencr/tab-sdk/protocol";

import { toastError } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { currentLiveTheme, subscribeLiveTheme } from "@/lib/themes/live-theme";

import { opaqueBackground } from "./theme-snapshot";

let syncing = false;

/** The theme guests are given in `hello`. */
export const currentPluginTabTheme = currentLiveTheme;

/** Called with every theme change, after the guests' stylesheet was pushed. */
export const subscribePluginTabTheme = subscribeLiveTheme;

function push(theme: ThemeSnapshot): void {
  const background = opaqueBackground(theme.tokens.background ?? "", theme.appearance);
  desktopBridge.pluginTabs
    .setTheme({ css: themeToCss(theme), background })
    .catch((error: unknown) => toastError(error, "Custom tabs could not follow the theme"));
}

/**
 * Start following the app theme, once for the whole renderer: push the guest
 * stylesheet + background to the main process now (before any guest opens)
 * and again whenever the theme changes. Idempotent.
 */
export function ensurePluginTabThemeSync(): void {
  if (syncing) return;
  syncing = true;
  push(currentLiveTheme());
  subscribeLiveTheme(push);
}
