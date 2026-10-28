import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-vite-plugin";
import {
  rendererCsp,
  rendererDevelopmentHeaders,
  resolveRendererCspDevelopment,
  type RendererCspDevelopmentEndpoints,
} from "./electron/main/csp";
import {
  electronBundleContractPlugin,
  type ElectronBundleContract,
} from "./electron/bundle-contract";
import { macNativeAddonPlugin } from "./electron/mac-native-addon";
import { devServiceProxy } from "./electron/dev-service-proxy";
import { rendererBuildInfo } from "./electron/renderer-build-info";
import pkg from "./package.json" with { type: "json" };

const rendererDiagnostics = rendererBuildInfo(pkg.version);

const excalidrawFontsDir = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")),
  "fonts",
);

const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

/**
 * `visual-lib:<name>`: the prebuilt bundle of a library HTML visuals inline as
 * text (`src/lib/visuals/visual-assets.ts`), served as a virtual module whose
 * default export is the source. Not an alias with `?raw`: the packages don't
 * export these files, and Vite's dependency optimizer pre-bundles an aliased
 * `node_modules` path and breaks the `?raw` query.
 */
function visualLibrariesPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const files: Record<string, string> = {
    "visual-lib:d3": path.resolve(path.dirname(require.resolve("d3")), "../dist/d3.min.js"),
    "visual-lib:chart.js": path.join(path.dirname(require.resolve("chart.js")), "chart.umd.min.js"),
  };
  return {
    name: "cadencr-visual-libraries",
    enforce: "pre",
    resolveId: (id) => (id in files ? `\0${id}` : null),
    load(id) {
      const file = id.startsWith("\0") ? files[id.slice(1)] : undefined;
      if (!file) return null;
      this.addWatchFile(file);
      return `export default ${JSON.stringify(fs.readFileSync(file, "utf8"))};`;
    },
  };
}

/** MIME types for the static assets served below; anything else gets none. */
const STATIC_ASSET_TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

interface StaticAssetDir {
  /** URL prefix under the renderer root, e.g. `/fonts/`. */
  urlPrefix: string;
  sourceDir: string;
  /** Skip files the renderer never loads (e.g. pdf.js's scripting engine). */
  include?: (fileName: string) => boolean;
}

/**
 * Serves third-party runtime assets from the renderer origin so they satisfy
 * the `'self'` CSP sources instead of a blocked CDN fetch:
 *  - Excalidraw's fonts (Excalifont, Nunito, …) under `/fonts/`; the runtime
 *    base is set via `window.EXCALIDRAW_ASSET_PATH` (`excalidraw-asset-path.ts`).
 *  - pdf.js's CMaps, standard fonts, ICC profiles and image-decoder wasm under
 *    `/pdfjs/` (see `pdfjs-assets.ts`).
 * In dev a middleware streams them from `node_modules`; for the packaged build
 * they're copied into the renderer output.
 */
function staticAssetDirsPlugin(dirs: readonly StaticAssetDir[]): Plugin {
  let outDir = "";
  return {
    name: "cadencr-static-asset-dirs",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const dir = dirs.find((entry) => req.url?.startsWith(entry.urlPrefix));
        if (!dir || !req.url) return next();
        const rel = decodeURIComponent(req.url.slice(dir.urlPrefix.length).split(/[?#]/)[0]);
        const filePath = path.join(dir.sourceDir, rel);
        if (!filePath.startsWith(dir.sourceDir + path.sep)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        if (dir.include && !dir.include(path.basename(filePath))) return next();
        fs.readFile(filePath, (err, data) => {
          if (err) return next();
          const type = STATIC_ASSET_TYPES[path.extname(filePath)];
          if (type) res.setHeader("Content-Type", type);
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.end(data);
        });
      });
    },
    closeBundle() {
      if (!outDir) return;
      for (const dir of dirs) {
        fs.cpSync(dir.sourceDir, path.join(outDir, dir.urlPrefix), {
          recursive: true,
          filter: (source) =>
            !dir.include || fs.statSync(source).isDirectory() || dir.include(path.basename(source)),
        });
      }
    },
  };
}

const STATIC_ASSET_DIRS: readonly StaticAssetDir[] = [
  { urlPrefix: "/fonts/", sourceDir: excalidrawFontsDir },
  ...["cmaps", "standard_fonts", "iccs", "wasm"].map((name) => ({
    urlPrefix: `/pdfjs/${name}/`,
    sourceDir: path.join(pdfjsDir, name),
    // pdf.js ships a QuickJS engine for PDF scripting, which the preview never enables.
    include: (fileName: string) => !fileName.startsWith("quickjs"),
  })),
];

function cspMetaPlugin(
  isProduction: boolean,
  developmentEndpoints: RendererCspDevelopmentEndpoints,
): Plugin {
  return {
    name: "cadencr-csp-meta",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: {
          "http-equiv": "Content-Security-Policy",
          content: rendererCsp(isProduction, developmentEndpoints),
        },
        injectTo: "head",
      },
    ],
  };
}

/**
 * Git branch this bundle is built from, consumed by the sidebar environment
 * badge (see `src/lib/app-environment.ts`): a `vX.Y.Z` integration branch shows
 * its version, anything else shows BETA. Packaged release builds check out a
 * tag, so HEAD is detached and they land on BETA.
 */
function resolveBuildBranch(): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    // Not fatal: building outside a git checkout just means no branch badge.
    console.warn(`[cadencr] could not resolve the build branch: ${String(error)}`);
    return "";
  }
}

const electronBundleContracts = {
  main: {
    processName: "main",
    entryFileName: path.basename(pkg.main),
    externalizationSentinels: ["electron", "electron-updater", "dotenv"],
  },
  preload: {
    processName: "preload",
    entryFileName: "index.js",
    externalizationSentinels: ["electron"],
    sandboxedEntryFileNames: ["notch.js", "plugin-tab.js"],
  },
} as const satisfies Record<"main" | "preload", ElectronBundleContract>;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "VITE_");
  const development = resolveRendererCspDevelopment(env);
  const serviceProxy = devServiceProxy(
    `http://127.0.0.1:${development.frontendPort}`,
    env.VITE_API_URL || "http://127.0.0.1:5005",
    env.VITE_API_TOKEN || "",
  );
  return {
    main: {
      plugins: [
        externalizeDepsPlugin(),
        electronBundleContractPlugin(electronBundleContracts.main),
        macNativeAddonPlugin(__dirname),
      ],
      build: {
        rollupOptions: {
          input: path.resolve(__dirname, "electron/main/index.ts"),
        },
      },
    },
    preload: {
      plugins: [
        externalizeDepsPlugin(),
        electronBundleContractPlugin(electronBundleContracts.preload),
      ],
      build: {
        rollupOptions: {
          input: {
            index: path.resolve(__dirname, "electron/preload/index.ts"),
            // The notch island's own, minimal preload (see electron/preload/notch.ts).
            notch: path.resolve(__dirname, "electron/preload/notch.ts"),
            // A custom-tab guest's preload: theme CSS + port forwarding only
            // (see electron/preload/plugin-tab.ts).
            "plugin-tab": path.resolve(__dirname, "electron/preload/plugin-tab.ts"),
          },
        },
      },
    },
    renderer: {
      root: ".",
      envDir: __dirname,
      envPrefix: ["VITE_API_URL", "VITE_FRONTEND_PORT"],
      server: {
        host: "127.0.0.1",
        port: development.frontendPort,
        strictPort: true,
        headers: rendererDevelopmentHeaders(development),
        proxy: serviceProxy.proxy,
      },
      define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
        __APP_BUILD_ID__: JSON.stringify(rendererDiagnostics.buildId),
        __APP_BUILD_BRANCH__: JSON.stringify(resolveBuildBranch()),
      },
      resolve: {
        alias: {
          "@": path.resolve(__dirname, "src"),
        },
      },
      // The Office preview engine loads its parser `.wasm` and render workers
      // via `new URL(…, import.meta.url)`; Vite < 8's dependency optimizer
      // moves the module and breaks those paths (production builds are fine).
      optimizeDeps: {
        exclude: ["@silurus/ooxml"],
      },
      plugins: [
        rendererDiagnostics.plugin,
        serviceProxy.plugin,
        visualLibrariesPlugin(),
        react(),
        tailwindcss(),
        staticAssetDirsPlugin(STATIC_ASSET_DIRS),
        cspMetaPlugin(mode === "production", development),
        TanStackRouterVite({
          routesDirectory: "src/routes",
          generatedRouteTree: "src/routeTree.gen.ts",
          routeFileIgnorePattern: ".test.tsx?$",
        }),
      ],
      build: {
        // Opt-in diagnostics: retain mappings without automatic browser downloads.
        sourcemap: process.env.CADENCR_RENDERER_SOURCEMAPS === "1" ? "hidden" : false,
        rollupOptions: {
          input: {
            index: path.resolve(__dirname, "index.html"),
            notch: path.resolve(__dirname, "notch.html"),
          },
        },
      },
    },
  };
});
