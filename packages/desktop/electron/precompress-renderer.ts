import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";
import type { Plugin } from "vite";

const brotli = promisify(brotliCompress);

/** Text-like files; images and `.woff`/`.woff2` fonts are compressed already. */
const COMPRESSIBLE = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".json",
  ".svg",
  ".wasm",
  ".txt",
  ".xml",
  ".webmanifest",
  ".bcmap",
  ".pfb",
  ".ttf",
  ".otf",
]);
/** Below this, the request costs more than the bytes it saves. */
const MIN_BYTES = 1024;
/** A copy that saves less than 10% is not worth shipping. */
const MAX_RATIO = 0.9;
/** Files in flight at once: bounds memory, the zlib thread pool does the work. */
const CONCURRENCY = 8;

/** Quality 11 takes 2.6 times the CPU of 10 to save 2.6% of the bytes. */
const QUALITY = 10;

function isCompressible(file: string): boolean {
  return COMPRESSIBLE.has(path.extname(file));
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** A copy whose source is gone or no longer compressed: the service would still serve it. */
function orphanCopies(files: readonly string[]): string[] {
  const present = new Set(files);
  return files.filter((file) => {
    if (path.extname(file) !== ".br") return false;
    const source = file.slice(0, -".br".length);
    return !present.has(source) || !isCompressible(source);
  });
}

/** Writes `<file>.br` beside the file, or removes a stale one when it would not pay. */
async function precompressFile(file: string): Promise<boolean> {
  const source = await readFile(file);
  const target = `${file}.br`;
  if (source.length >= MIN_BYTES) {
    const compressed = await brotli(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    });
    if (compressed.length <= source.length * MAX_RATIO) {
      await writeFile(target, compressed);
      return true;
    }
  }
  // The service serves any `.br` it finds, so none may outlive its source's content.
  await rm(target, { force: true });
  return false;
}

/**
 * Writes a high-quality Brotli copy beside each compressible file under
 * `dir`, which the service's remote listener sends as is to a browser that
 * accepts `br` (see `packages/service/src/remote/spa.rs`) instead of
 * compressing the file again on every request, and removes any `.br` that
 * no longer matches a source. Returns how many it wrote.
 */
export async function precompressDir(dir: string): Promise<number> {
  const files = await listFiles(dir);
  await Promise.all(orphanCopies(files).map((file) => rm(file)));
  const queue = files.filter(isCompressible);
  let written = 0;
  const worker = async (): Promise<void> => {
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (await precompressFile(file)) written += 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return written;
}

/**
 * The renderer build's last step: precompress the output once every other
 * plugin (the static asset copies included) has written into it.
 */
export function precompressRendererPlugin(): Plugin {
  let outDir = "";
  return {
    name: "cadencr-precompress-renderer",
    apply: "build",
    configResolved(config) {
      if (config.build.write) outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (!outDir) return;
        const started = Date.now();
        const written = await precompressDir(outDir);
        this.info(`precompressed ${written} files with Brotli in ${Date.now() - started} ms`);
      },
    },
  };
}
