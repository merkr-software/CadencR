import { defineConfig } from "orval";

/**
 * Generates `src/generated/api.ts`, the typed client of the plugin surface
 * (`@cadencr/tab-sdk/api`), from `openapi.plugin.json`.
 *
 * That document is the service's OpenAPI filtered to the routes a custom tab
 * may call (`dump-openapi --plugin-surface`, gitignored). Run via
 * `pnpm --filter @cadencr/tab-sdk generate:api`. Every generated function
 * goes through `pluginFetch`, i.e. the host's `api.request` over the port: it
 * resolves the parsed body and throws `CadencrError` on non-2xx.
 */
export default defineConfig({
  plugin: {
    input: { target: "./openapi.plugin.json" },
    output: {
      target: "./src/generated/api.ts",
      client: "fetch",
      mode: "single",
      override: {
        mutator: { path: "./src/fetcher.ts", name: "pluginFetch" },
        fetch: { includeHttpResponseReturnType: false },
      },
    },
  },
});
