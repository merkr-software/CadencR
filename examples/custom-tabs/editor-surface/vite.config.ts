import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// This in-repository example exercises the unreleased SDK from this checkout.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  resolve: {
    alias: {
      "@cadencr/tab-sdk": fileURLToPath(
        new URL("../../../packages/tab-sdk/src/index.ts", import.meta.url),
      ),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
