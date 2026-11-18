import { readFile } from "node:fs/promises";
import type { DepOptimizationOptions, Plugin } from "vite";

type EsbuildPlugin = NonNullable<
  NonNullable<DepOptimizationOptions["esbuildOptions"]>["plugins"]
>[number];

/**
 * Excalidraw lists an esm.sh URL after `window.EXCALIDRAW_ASSET_PATH` in every
 * FontFace `src`. Chromium checks each source against the renderer CSP
 * (`font-src 'self' data:`) as soon as the FontFace is built, so opening a
 * scene logged ~460 refusals even though the local fonts load. These rewrites
 * keep the CDN only when no local base is set (`excalidraw-asset-path.ts`
 * always sets one), in each published build of the package: `dist/dev` (Vite
 * dev, through the esbuild dependency pre-bundle) and `dist/prod` (production
 * build, through Rollup).
 */
const FALLBACK_REWRITES: ReadonlyArray<{ from: string; to: string }> = [
  {
    from: "    urls.push(new URL(assetUrl, _ExcalidrawFontFace.ASSETS_FALLBACK_URL));",
    to: "    if (urls.length === 0) urls.push(new URL(assetUrl, _ExcalidrawFontFace.ASSETS_FALLBACK_URL));",
  },
  {
    from: "return r.push(new URL(n,jn.ASSETS_FALLBACK_URL)),r}",
    to: "return r.length||r.push(new URL(n,jn.ASSETS_FALLBACK_URL)),r}",
  },
];

const EXCALIDRAW_DIST_FILE =
  /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/](?:dev|prod)[\\/][^\\/]+\.js$/;
const FALLBACK_MARKERS = ["ASSETS_FALLBACK_URL", "https://esm.sh/"];
const PLUGIN_NAME = "cadencr-excalidraw-font-fallback";

function staleError(detail: string): Error {
  return new Error(
    `${PLUGIN_NAME}: ${detail}. Excalidraw changed how it adds its esm.sh font fallback; ` +
      "update FALLBACK_REWRITES in electron/excalidraw-font-fallback.ts, or the renderer " +
      "CSP will refuse a CDN source for every Excalidraw font again.",
  );
}

/**
 * The rewritten source of an Excalidraw dist file that adds the font fallback,
 * or `null` for any other file. Throws when the file adds it in a form no
 * rewrite matches exactly once.
 */
export function rewriteExcalidrawFontFallback(code: string, id: string): string | null {
  if (!EXCALIDRAW_DIST_FILE.test(id) || !FALLBACK_MARKERS.some((m) => code.includes(m))) {
    return null;
  }
  for (const { from, to } of FALLBACK_REWRITES) {
    const occurrences = code.split(from).length - 1;
    if (occurrences === 1) return code.replace(from, to);
    if (occurrences > 1)
      throw staleError(`${id} matches the fallback rewrite ${occurrences} times`);
  }
  throw staleError(`${id} adds the fallback in a form no rewrite recognizes`);
}

/** Fails a bundle that loaded Excalidraw's dist without rewriting its fallback. */
class RewriteTally {
  private loaded = false;
  private rewritten = false;

  record(id: string, rewritten: boolean): void {
    this.loaded ||= EXCALIDRAW_DIST_FILE.test(id);
    this.rewritten ||= rewritten;
  }

  assertComplete(): void {
    if (this.loaded && !this.rewritten) {
      throw staleError("Excalidraw was bundled but no file added the fallback any more");
    }
  }
}

/** Production build: Rollup transform over Excalidraw's `dist/prod`. */
export function excalidrawFontFallbackVitePlugin(): Plugin {
  let tally = new RewriteTally();
  return {
    name: PLUGIN_NAME,
    enforce: "pre",
    apply: "build",
    buildStart() {
      tally = new RewriteTally();
    },
    transform(code, id) {
      const rewritten = rewriteExcalidrawFontFallback(code, id);
      tally.record(id, rewritten !== null);
      return rewritten === null ? null : { code: rewritten, map: null };
    },
    buildEnd(error) {
      if (!error) tally.assertComplete();
    },
  };
}

/** Vite dev: esbuild dependency pre-bundle over Excalidraw's `dist/dev`. */
export function excalidrawFontFallbackEsbuildPlugin(): EsbuildPlugin {
  return {
    name: PLUGIN_NAME,
    setup(build) {
      let tally = new RewriteTally();
      build.onStart(() => {
        tally = new RewriteTally();
      });
      build.onLoad({ filter: EXCALIDRAW_DIST_FILE }, async ({ path }) => {
        const rewritten = rewriteExcalidrawFontFallback(await readFile(path, "utf8"), path);
        tally.record(path, rewritten !== null);
        return rewritten === null ? undefined : { contents: rewritten, loader: "js" };
      });
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        tally.assertComplete();
      });
    },
  };
}
