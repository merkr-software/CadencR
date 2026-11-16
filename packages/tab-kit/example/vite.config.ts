import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const kitRoot = resolve(__dirname, "..");

/** A consumer of the built kit, resolved the way a plugin resolves the
 *  installed package (exports + dist), never the kit's sources. */
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [tailwindcss()],
  resolve: {
    alias: [{ find: /^@cadencr\/tab-kit/, replacement: kitRoot }],
  },
  build: { outDir: resolve(__dirname, "dist"), emptyOutDir: true },
  logLevel: "warn",
});
