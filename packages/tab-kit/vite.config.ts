import { resolve } from "node:path";
import { defineConfig } from "vite";
import { thirdPartyLicenses } from "./scripts/third-party-licenses";

const desktopSrc = resolve(__dirname, "../desktop/src");

/** Library build: desktop UI components with radix/cva/clsx/tailwind-merge/
 *  lucide bundled in; only React stays external (a peer dependency). */
export default defineConfig({
  resolve: { alias: { "@": desktopSrc } },
  esbuild: { jsx: "automatic" },
  plugins: [thirdPartyLicenses()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [/^react($|\/)/, /^react-dom($|\/)/],
      onwarn(warning, warn) {
        // Radix (and a few desktop components) start with "use client", which
        // means nothing in a client bundle; rollup also fails to map that
        // directive's location back through the TSX transform.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        if (warning.code === "SOURCEMAP_ERROR" && warning.loc?.line === 1) return;
        warn(warning);
      },
    },
  },
});
