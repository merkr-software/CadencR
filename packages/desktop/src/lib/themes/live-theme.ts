import type { ThemeSnapshot } from "@cadencr/tab-sdk/protocol";

import { readThemeSnapshot } from "@/lib/plugin-tabs/theme-snapshot";

type LiveThemeListener = (theme: ThemeSnapshot) => void;

let current: ThemeSnapshot | null = null;
let currentKey = "";
let observer: MutationObserver | null = null;
const listeners = new Set<LiveThemeListener>();

function refresh(): void {
  const theme = readThemeSnapshot();
  const key = JSON.stringify(theme);
  if (key === currentKey) return;
  current = theme;
  currentKey = key;
  for (const listener of listeners) listener(theme);
}

/**
 * Follow the app theme, once for the whole renderer. A theme switch flips
 * `data-theme`/`data-appearance` on `<html>`; editing a user theme rewrites
 * the injected token `<style>` in `<head>` — both are observed; a
 * MutationObserver already batches a burst of mutations into one callback,
 * and the re-read is deduplicated on content. Not tied to animation frames,
 * so a theme change while the window is hidden is still seen.
 */
function observe(): void {
  // No DOM to follow outside the renderer (node tests).
  if (observer || typeof MutationObserver === "undefined") return;
  refresh();
  observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-appearance", "class", "style"],
  });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
}

/** The theme as the app paints it; the same object until the theme changes. */
export function currentLiveTheme(): ThemeSnapshot {
  observe();
  return current ?? readThemeSnapshot();
}

/** Called with every later theme change. */
export function subscribeLiveTheme(listener: LiveThemeListener): () => void {
  observe();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
