import { defineConfig } from "vitest/config";

// Tests run against the built dist/: turbo's `@cadencr/tab-kit#test` depends
// on the (cached) build. Running vitest directly needs `pnpm build` first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
