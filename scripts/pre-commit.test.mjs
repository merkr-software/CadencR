import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPrecommitPlan,
  checkEnv,
  classifyPath,
  formatCommand,
  parseNameStatus,
  runPlan,
} from "./pre-commit.mjs";

const plan = (paths, options) =>
  buildPrecommitPlan(
    paths.map((path) => (typeof path === "string" ? { path } : path)),
    options,
  );
const commands = (result) => result.steps.map(({ command }) => formatCommand(command));
const labels = (result) => result.steps.map(({ label }) => label);

const AGENTS = "node scripts/build-agents-md.mjs --check";
const ROOT_TESTS = "pnpm run test:scripts";
const RUST = [
  "pnpm --filter @cadencr/service run format:check",
  "pnpm --filter @cadencr/service run lint",
  "pnpm --filter @cadencr/service run test",
];
const FULL = "pnpm turbo run format:check lint ts-check test knip --log-order=stream";

test("an empty or docs-only commit only checks AGENTS.md", () => {
  assert.deepEqual(commands(plan([])), [AGENTS]);
  const docs = plan([
    "README.md",
    "docs/qa/x.png",
    "packages/service/README.md",
    ".claude/rules/a.md",
  ]);
  assert.equal(docs.mode, "docs");
  assert.deepEqual(commands(docs), [AGENTS]);
});

test("markdown inside a package's src/ is content, not docs", () => {
  assert.deepEqual(classifyPath("packages/landing/src/content/docs/intro.mdx"), [
    "other",
    "landing",
  ]);
  assert.deepEqual(classifyPath("packages/landing/README.md"), ["docs"]);
});

test("a desktop source change runs desktop static checks and only related tests", () => {
  const result = plan([
    "packages/desktop/src/lib/foo.ts",
    "packages/desktop/electron/main/bar.test.ts",
    "packages/desktop/src/assets/logo.png",
  ]);
  assert.equal(result.mode, "scoped");
  assert.deepEqual(commands(result), [
    AGENTS,
    "pnpm run check:provider-boundaries",
    ROOT_TESTS,
    "pnpm turbo run format:check lint ts-check knip --filter=@cadencr/desktop --log-order=stream",
    "pnpm --filter @cadencr/desktop exec vitest related --run --passWithNoTests src/lib/foo.ts electron/main/bar.test.ts",
  ]);
});

test("deleted desktop files still route to desktop checks but are not traced", () => {
  const result = plan([{ path: "packages/desktop/src/old.ts", deleted: true }]);
  assert.ok(commands(result).some((command) => command.includes("--filter=@cadencr/desktop")));
  assert.ok(!commands(result).some((command) => command.includes("vitest related")));
});

test("vitest config, setup or package.json changes run the full desktop suite", () => {
  for (const path of [
    "packages/desktop/vitest.config.ts",
    "packages/desktop/src/test-setup.ts",
    "packages/desktop/src/test-setup-dom.ts",
    "packages/desktop/src/test/msw-server.ts",
    "packages/desktop/package.json",
  ]) {
    const result = commands(plan([path, "packages/desktop/src/lib/foo.ts"]));
    assert.ok(
      result.includes("pnpm turbo run test --filter=@cadencr/desktop --log-order=stream"),
      path,
    );
    assert.ok(!result.some((command) => command.includes("vitest related")), path);
  }
});

test("desktop shortcut registry changes also check landing, which imports it", () => {
  const result = commands(plan(["packages/desktop/src/lib/shortcuts/entries.ts"]));
  assert.ok(
    result.includes(
      "pnpm turbo run format:check lint ts-check knip --filter=@cadencr/desktop --filter=@cadencr/landing --log-order=stream",
    ),
  );
  assert.ok(result.includes("pnpm turbo run test --filter=@cadencr/landing --log-order=stream"));
});

test("brand changes check brand and both consumers, tracing brand files from desktop", () => {
  const result = commands(plan(["packages/brand/src/tokens.mjs"]));
  assert.ok(
    result.includes(
      "pnpm turbo run format:check lint ts-check knip --filter=@cadencr/desktop --filter=@cadencr/landing --filter=@cadencr/brand --log-order=stream",
    ),
  );
  assert.ok(
    result.includes(
      "pnpm turbo run test --filter=@cadencr/landing --filter=@cadencr/brand --log-order=stream",
    ),
  );
  assert.ok(
    result.at(-1).endsWith("vitest related --run --passWithNoTests ../brand/src/tokens.mjs"),
  );
});

test("brand files outside src/ check only brand", () => {
  const result = commands(plan(["packages/brand/scripts/render.mjs"]));
  assert.ok(
    result.includes(
      "pnpm turbo run format:check lint ts-check knip --filter=@cadencr/brand --log-order=stream",
    ),
  );
  assert.ok(!result.some((command) => command.includes("@cadencr/desktop")));
});

test("staged name-status fields become paths flagged when deleted", () => {
  assert.deepEqual(parseNameStatus(["M", "a.ts", "D", "b.ts", "A", "c.ts"]), [
    { path: "a.ts", deleted: false },
    { path: "b.ts", deleted: true },
    { path: "c.ts", deleted: false },
  ]);
});

test("Rust changes anywhere in the workspace run service fmt, clippy and tests", () => {
  for (const path of [
    "packages/service/src/main.rs",
    "packages/service/migrations/0100_x.sql",
    "packages/opencode-sdk-rs/src/lib.rs",
    "packages/cli-discovery/src/lib.rs",
    "Cargo.lock",
    "rust-toolchain.toml",
  ]) {
    const result = commands(plan([path]));
    assert.deepEqual(result.slice(-2), RUST.slice(1), path);
    assert.ok(result.includes(RUST[0]), path);
    assert.ok(!result.some((command) => command.includes("turbo")), path);
  }
});

test("Rust fmt runs before slow web checks; clippy and tests run last", () => {
  const result = commands(plan(["packages/service/src/x.rs", "packages/landing/src/a.ts"]));
  const index = (needle) => result.findIndex((command) => command.includes(needle));
  assert.ok(index("run format:check") < index("turbo run format:check"));
  assert.ok(index("turbo run test") < index("service run lint"));
  assert.equal(result.at(-1), RUST[2]);
});

test("scripts and workflow changes run the root tests; release inputs add release tests", () => {
  assert.deepEqual(commands(plan(["scripts/doctor.mjs"])), [AGENTS, ROOT_TESTS]);
  assert.deepEqual(commands(plan([".github/workflows/ci.yml"])), [AGENTS, ROOT_TESTS]);
  for (const path of [
    "scripts/release.sh",
    ".github/workflows/desktop-release.yml",
    "homebrew/x.rb",
  ]) {
    assert.deepEqual(labels(plan([path])).slice(-1), ["release script tests"], path);
  }
});

test("root tooling changes and CADENCR_PRECOMMIT_FULL run everything", () => {
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    ".husky/pre-commit",
  ]) {
    const result = plan(["README.md", path]);
    assert.equal(result.mode, "full", path);
    assert.ok(commands(result).includes(FULL), path);
  }
  const forced = plan(["README.md"], { full: true });
  assert.equal(forced.mode, "full");
  assert.deepEqual(commands(forced), [
    AGENTS,
    "pnpm run check:provider-boundaries",
    ROOT_TESTS,
    "pnpm run test:release-scripts",
    FULL,
  ]);
});

test("checks do not inherit the hook's git index variables", () => {
  const env = checkEnv({ PATH: "/bin", GIT_INDEX_FILE: ".git/index.lock", GIT_DIR: ".git" });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("formatCommand quotes arguments a shell would split", () => {
  assert.equal(formatCommand(["vitest", "src/a b.ts", "it's"]), `vitest 'src/a b.ts' 'it'\\''s'`);
});

test("the husky hook delegates to this script", () => {
  const hook = readFileSync(new URL("../.husky/pre-commit", import.meta.url), "utf8");
  assert.match(hook, /^node scripts\/pre-commit\.mjs$/m);
});

test("the runner stops at the first failing step and returns its exit code", () => {
  const marker = join(mkdtempSync(join(tmpdir(), "cadencr-precommit-")), "ran");
  const status = runPlan({
    steps: [
      { label: "fails", command: [process.execPath, "-e", "process.exit(3)"] },
      {
        label: "skipped",
        command: [
          process.execPath,
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`,
        ],
      },
    ],
  });
  assert.equal(status, 3);
  assert.equal(existsSync(marker), false);
});
