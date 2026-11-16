import path from "path";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Branch detection is a build-time concern; unit tests drive
    // `resolveAppEnvironmentKind` directly instead.
    __APP_BUILD_BRANCH__: JSON.stringify(""),
  },
  test: {
    setupFiles: ["src/test-setup.ts"],
    // Worker threads boot faster than forked processes. They share one process,
    // so tests must not `process.chdir` or assume a closed fd number stays
    // unused (see `electron/main/test-descriptor.ts`).
    pool: "threads",
    teardownTimeout: 3000,
    // Files that affect every test without being in any test's import graph:
    // watch mode runs the whole suite when one changes (pre-commit mirrors this
    // list in DESKTOP_FULL_SUITE, scripts/pre-commit.mjs). Anchored to this directory because a leading `**` never matches
    // a dot-directory, and worktrees live under `~/.cadencr/` — which is why
    // vitest's own `**/package.json/**`-style defaults never fire here.
    forceRerunTriggers: [
      path.resolve(__dirname, "package.json"),
      path.resolve(__dirname, "../../pnpm-lock.yaml"),
      path.resolve(__dirname, "vitest.config.ts"),
      path.resolve(__dirname, "src/test-setup.ts"),
      path.resolve(__dirname, "src/test-setup-dom.ts"),
      path.resolve(__dirname, "src/test/**"),
    ],
    // Environments, split by extension:
    // - `.test.tsx` (components) run in happy-dom — far cheaper per file than
    //   jsdom.
    // - `.test.ts` run in plain Node and skip the DOM-only setup
    //   (`src/test-setup-dom.ts`). One that needs a DOM opts in with a
    //   `// @vitest-environment happy-dom` docblock on line 1.
    // - A file that depends on jsdom-specific behavior (computed colors,
    //   focus, layout, sanitizer semantics) pins `// @vitest-environment jsdom`
    //   with a one-line reason underneath.
    projects: [
      {
        extends: true,
        test: {
          name: "dom",
          environment: "happy-dom",
          include: ["src/**/*.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "electron/**/*.test.ts"],
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
