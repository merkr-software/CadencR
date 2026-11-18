/**
 * Points Excalidraw at Cadencr's self-hosted fonts (Excalifont, Nunito, …).
 *
 * Excalidraw otherwise fetches its fonts from a CDN (esm.sh), which the
 * renderer CSP (`font-src 'self'`) blocks — so hand-drawn text silently fell
 * back to a system font. We serve the fonts at `<renderer-root>/fonts/...`
 * instead (dev: a Vite middleware; packaged: copied into the build output by
 * the `cadencr-static-asset-dirs` plugin in `electron.vite.config.ts`).
 * Upstream still appends the CDN to every font's `src` after this base, and
 * Chromium checks every source against the CSP when the FontFace is built;
 * `electron/excalidraw-font-fallback.ts` drops it at bundle time while a base
 * is set.
 *
 * The app uses a hash router, so `location.pathname` never changes and the
 * document directory is a stable base in both the dev server (`http://…/`) and
 * the packaged `file://…/out/renderer/` shell. A full absolute URL is passed so
 * Excalidraw uses it verbatim rather than resolving against `location.origin`
 * (which is unreliable under `file://`).
 *
 * Imported for its side effect *before* `@excalidraw/excalidraw` so the global
 * is set prior to any font resolution.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

if (typeof window !== "undefined" && !window.EXCALIDRAW_ASSET_PATH) {
  window.EXCALIDRAW_ASSET_PATH = new URL(".", window.location.href).toString();
}

export {};
