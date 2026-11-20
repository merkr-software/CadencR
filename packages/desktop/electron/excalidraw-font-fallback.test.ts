import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { build, optimizeDeps, resolveConfig, type DepOptimizationOptions } from "vite";
import { describe, expect, it } from "vitest";
import {
  excalidrawFontFallbackEsbuildPlugin,
  excalidrawFontFallbackVitePlugin,
  rewriteExcalidrawFontFallback,
} from "./excalidraw-font-fallback";

type EsbuildPlugin = NonNullable<
  NonNullable<DepOptimizationOptions["esbuildOptions"]>["plugins"]
>[number];
type PluginBuild = Parameters<EsbuildPlugin["setup"]>[0];

const prodDir = path.dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw"));

/** The installed dist file of `build` that adds the esm.sh font fallback. */
function installedFallbackFile(build: "dev" | "prod"): {
  file: string;
  code: string;
} {
  const dir = path.join(prodDir, "..", build);
  const matches = readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({
      file: path.join(dir, name),
      code: readFileSync(path.join(dir, name), "utf8"),
    }))
    .filter(({ code }) => code.includes("ASSETS_FALLBACK_URL"));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/** Builds an entry importing a fake Excalidraw prod file holding `code`. */
async function buildWithFakeExcalidraw(code: string): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), "cadencr-excalidraw-fonts-"));
  const dist = path.join(root, "node_modules/@excalidraw/excalidraw/dist/prod");
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, "chunk.js"), code);
  writeFileSync(
    path.join(root, "index.js"),
    `import * as fonts from "${path.join(dist, "chunk.js")}";\nconsole.log(fonts);`,
  );
  const output = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [excalidrawFontFallbackVitePlugin()],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: path.join(root, "index.js") },
    },
  }).finally(() => rmSync(root, { recursive: true, force: true }));
  const [result] = Array.isArray(output) ? output : [output];
  if (!result || !("output" in result)) throw new Error("expected an in-memory build");
  return result.output.map((chunk) => ("code" in chunk ? chunk.code : "")).join("\n");
}

const STALE = /FALLBACK_REWRITES/;

describe("rewriteExcalidrawFontFallback", () => {
  it.each(["dev", "prod"] as const)("keeps the CDN out of the installed %s build", (dist) => {
    const { file, code } = installedFallbackFile(dist);
    const rewritten = rewriteExcalidrawFontFallback(code, file);
    expect(rewritten).not.toBeNull();
    expect(rewritten).toMatch(/urls\.length === 0\) urls\.push|r\.length\|\|r\.push/);
  });

  it("leaves other modules alone", () => {
    const fallback = "x.push(new URL(n, ASSETS_FALLBACK_URL))";
    expect(rewriteExcalidrawFontFallback(fallback, "/app/src/fonts.js")).toBeNull();
    expect(
      rewriteExcalidrawFontFallback("export {};", "/n/@excalidraw/excalidraw/dist/prod/a.js"),
    ).toBeNull();
  });

  it("fails clearly when Excalidraw adds the fallback in a new form", () => {
    const id = "/n/@excalidraw/excalidraw/dist/prod/chunk.js";
    expect(() => rewriteExcalidrawFontFallback("u.add(ASSETS_FALLBACK_URL)", id)).toThrow(STALE);
  });
});

describe("excalidrawFontFallbackVitePlugin", () => {
  it("rewrites the fallback in a production build", async () => {
    const code = await buildWithFakeExcalidraw(
      "const jn={ASSETS_FALLBACK_URL:'https://esm.sh/x/'};" +
        "export function u(n){const r=[];return r.push(new URL(n,jn.ASSETS_FALLBACK_URL)),r}",
    );
    expect(code).toMatch(/r\.length \|\| r\.push/);
  });

  it("fails a build whose Excalidraw fallback no rewrite matches", async () => {
    await expect(
      buildWithFakeExcalidraw("export const u = (n) => [new URL(n, ASSETS_FALLBACK_URL)];"),
    ).rejects.toThrow(STALE);
  });

  it("fails a build that bundled Excalidraw without finding the fallback", async () => {
    await expect(buildWithFakeExcalidraw("export const u = 1;")).rejects.toThrow(STALE);
  });
});

describe("excalidrawFontFallbackEsbuildPlugin", () => {
  type OnLoad = (args: { path: string }) => Promise<{ contents: string } | undefined>;
  type OnEnd = (result: { errors: unknown[] }) => void;

  function setUp(): { onLoad: OnLoad; onEnd: OnEnd } {
    const hooks: { onLoad?: OnLoad; onEnd?: OnEnd } = {};
    const fakeBuild = {
      onStart: (callback: () => void) => callback(),
      onLoad: (_options: unknown, callback: OnLoad) => (hooks.onLoad = callback),
      onEnd: (callback: OnEnd) => (hooks.onEnd = callback),
    };
    void excalidrawFontFallbackEsbuildPlugin().setup(fakeBuild as unknown as PluginBuild);
    if (!hooks.onLoad || !hooks.onEnd) throw new Error("plugin registered no hooks");
    return { onLoad: hooks.onLoad, onEnd: hooks.onEnd };
  }

  it("rewrites the installed dev build in the dependency pre-bundle", async () => {
    const { onLoad, onEnd } = setUp();
    const loaded = await onLoad({ path: installedFallbackFile("dev").file });
    expect(loaded?.contents).toContain("if (urls.length === 0) urls.push(");
    expect(() => onEnd({ errors: [] })).not.toThrow();
  });

  it("fails a pre-bundle that loaded Excalidraw without finding the fallback", async () => {
    const { onLoad, onEnd } = setUp();
    const { file } = installedFallbackFile("dev");
    const other = readdirSync(path.dirname(file)).find(
      (name) =>
        name.endsWith(".js") &&
        !readFileSync(path.join(path.dirname(file), name), "utf8").includes("esm.sh"),
    );
    expect(await onLoad({ path: path.join(path.dirname(file), other!) })).toBeUndefined();
    expect(() => onEnd({ errors: [] })).toThrow(STALE);
  });
});

describe("dependency pre-bundle cache", () => {
  const fallback = "    urls.push(new URL(assetUrl, _ExcalidrawFontFace.ASSETS_FALLBACK_URL));";

  /** A project whose `@excalidraw/excalidraw` dev build adds the fallback. */
  function fakeProject(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "cadencr-excalidraw-prebundle-"));
    const pkg = path.join(root, "node_modules/@excalidraw/excalidraw");
    mkdirSync(path.join(pkg, "dist/dev"), { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@excalidraw/excalidraw",
        version: "0.0.0",
        type: "module",
        module: "dist/dev/index.js",
      }),
    );
    writeFileSync(
      path.join(pkg, "dist/dev/index.js"),
      "const _ExcalidrawFontFace = { ASSETS_FALLBACK_URL: 'https://esm.sh/x/' };\n" +
        `export function urlsOf(assetUrl) {\n  const urls = [];\n${fallback}\n  return urls;\n}\n`,
    );
    return root;
  }

  /** Pre-bundles the fake Excalidraw as Vite dev does, reusing `.vite` when its key matches. */
  async function preBundle(root: string, marker: string): Promise<string> {
    const plugin = excalidrawFontFallbackEsbuildPlugin([
      { from: fallback, to: `    if (urls.length === 0) urls.push("${marker}");` },
    ]);
    const config = await resolveConfig(
      {
        root,
        // Vite would otherwise cache under the nearest `package.json` above `root`.
        cacheDir: path.join(root, ".vite"),
        configFile: false,
        logLevel: "silent",
        optimizeDeps: {
          noDiscovery: true,
          include: ["@excalidraw/excalidraw"],
          esbuildOptions: { plugins: [plugin] },
        },
      },
      "serve",
    );
    await optimizeDeps(config);
    return readFileSync(path.join(config.cacheDir, "deps/@excalidraw_excalidraw.js"), "utf8");
  }

  it("rebuilds the pre-bundle when the rewrites change", async () => {
    const root = fakeProject();
    try {
      expect(await preBundle(root, "first rewrites")).toContain('"first rewrites"');
      expect(await preBundle(root, "second rewrites")).toContain('"second rewrites"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
