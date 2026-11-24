import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { build, type Plugin } from "vite";
import { afterEach, expect, it } from "vitest";
import { precompressDir, precompressRendererPlugin } from "./precompress-renderer";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cadencr-precompress-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("writes a Brotli copy only where it pays, and drops stale ones", async () => {
  const dir = tempDir();
  mkdirSync(path.join(dir, "assets/nested"), { recursive: true });
  const script = Buffer.from("export const value = 1;\n".repeat(400));
  writeFileSync(path.join(dir, "assets/nested/app.js"), script);
  writeFileSync(path.join(dir, "index.html"), "<html></html>"); // under 1 KB
  writeFileSync(path.join(dir, "assets/font.woff2"), script); // not a compressible type
  writeFileSync(path.join(dir, "assets/random.js"), randomBytes(8192)); // does not shrink
  // Left by an earlier build: beside a file that no longer pays, a file not
  // compressed any more, and a file that is gone.
  writeFileSync(path.join(dir, "assets/random.js.br"), "stale");
  writeFileSync(path.join(dir, "assets/font.woff2.br"), "stale");
  writeFileSync(path.join(dir, "assets/removed.js.br"), "stale");

  await expect(precompressDir(dir)).resolves.toBe(1);

  const copy = readFileSync(path.join(dir, "assets/nested/app.js.br"));
  expect(brotliDecompressSync(copy).equals(script)).toBe(true);
  const gone = [
    "index.html.br",
    "assets/font.woff2.br",
    "assets/random.js.br",
    "assets/removed.js.br",
  ];
  for (const name of gone) expect(existsSync(path.join(dir, name)), name).toBe(false);
});

it("compresses the renderer output once every plugin has written it", async () => {
  const root = tempDir();
  const big = JSON.stringify("a".repeat(4096));
  // A side effect, so the chunk is not tree-shaken away.
  writeFileSync(path.join(root, "index.js"), `console.log(${big});`);
  // Like the static asset copies: a plugin listed before, writing on close.
  const lateWriter: Plugin = {
    name: "late-writer",
    closeBundle() {
      writeFileSync(path.join(root, "dist/copied.js"), `console.log(${big});`);
    },
  };
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    publicDir: false,
    plugins: [precompressRendererPlugin(), lateWriter],
    build: {
      minify: false,
      rollupOptions: { input: path.join(root, "index.js"), output: { entryFileNames: "out.js" } },
    },
  });
  expect(existsSync(path.join(root, "dist/out.js.br"))).toBe(true);
  expect(existsSync(path.join(root, "dist/copied.js.br"))).toBe(true);
});
