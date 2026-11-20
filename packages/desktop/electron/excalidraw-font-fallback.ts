import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DepOptimizationOptions, Plugin } from "vite";

type EsbuildPlugin = NonNullable<
  NonNullable<DepOptimizationOptions["esbuildOptions"]>["plugins"]
>[number];
type FallbackRewrites = ReadonlyArray<{ from: string; to: string }>;

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
const FALLBACK_REWRITES: FallbackRewrites = [
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
export function rewriteExcalidrawFontFallback(
  code: string,
  id: string,
  rewrites: FallbackRewrites = FALLBACK_REWRITES,
): string | null {
  if (!EXCALIDRAW_DIST_FILE.test(id) || !FALLBACK_MARKERS.some((m) => code.includes(m))) {
    return null;
  }
  for (const { from, to } of rewrites) {
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

/**
 * The rewrites and the code applying them, as a short hash. Vite keys its
 * dependency pre-bundle cache (`.vite/deps`) on the optimizer's esbuild plugin
 * names, not on their code, so a pre-bundle made with other rewrites would
 * otherwise be served again until the lockfile changed.
 */
function rewritesFingerprint(rewrites: FallbackRewrites): string {
  const applied = [EXCALIDRAW_DIST_FILE.source, FALLBACK_MARKERS, rewrites];
  return createHash("sha256")
    .update(JSON.stringify([...applied, rewriteExcalidrawFontFallback.toString()]))
    .digest("hex")
    .slice(0, 12);
}

/**
 * Vite dev: esbuild dependency pre-bundle over Excalidraw's `dist/dev`. Its
 * name carries the rewrites' fingerprint, which keys the pre-bundle cache.
 */
export function excalidrawFontFallbackEsbuildPlugin(
  rewrites: FallbackRewrites = FALLBACK_REWRITES,
): EsbuildPlugin {
  return {
    name: `${PLUGIN_NAME}-${rewritesFingerprint(rewrites)}`,
    setup(build) {
      let tally = new RewriteTally();
      build.onStart(() => {
        tally = new RewriteTally();
      });
      build.onLoad({ filter: EXCALIDRAW_DIST_FILE }, async ({ path }) => {
        const code = await readFile(path, "utf8");
        const rewritten = rewriteExcalidrawFontFallback(code, path, rewrites);
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
