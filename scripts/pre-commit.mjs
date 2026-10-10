// Scoped pre-commit: run only the checks the staged files can affect.
//
//   node scripts/pre-commit.mjs            # what .husky/pre-commit runs
//   node scripts/pre-commit.mjs --dry-run  # print the plan, run nothing
//   CADENCR_PRECOMMIT_FULL=1 git commit    # force the full workspace check
//
// `buildPrecommitPlan` is pure (staged paths in, ordered steps out) so the
// routing rules are unit-tested in scripts/pre-commit.test.mjs.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

const JS_PACKAGES = {
  desktop: "@cadencr/desktop",
  landing: "@cadencr/landing",
  brand: "@cadencr/brand",
};
const RUST_ROOT_FILES = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "rustfmt.toml",
  "clippy.toml",
  "deny.toml",
]);
const RUST_PACKAGE = /^packages\/(service|cli-discovery|[^/]+-rs)\//;
// Files that configure every package's tooling: any change re-checks everything.
const FULL_ROOT_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  ".oxlintrc.json",
  ".oxfmtrc.json",
  ".npmrc",
  ".nvmrc",
  ".node-version",
]);
const FULL_PREFIXES = [".husky/", "patches/"];
const RELEASE_INPUTS = [
  /^scripts\/(release|update-homebrew-cask|desktop-release-workflow)[^/]*$/,
  /^\.github\/workflows\/desktop-release\.yml$/,
  /^homebrew\//,
];
// Desktop files outside any test's import graph that still change every test:
// the vitest config, the setup file and what it loads, and the dependency set.
const DESKTOP_FULL_SUITE =
  /^packages\/desktop\/(vitest\.[^/]+|package\.json|src\/test-setup[^/]*\.tsx?|src\/test\/)/;
// packages/landing type-checks and tests the desktop shortcut registry.
const LANDING_READS_DESKTOP = /^packages\/desktop\/src\/(lib\/shortcuts|shared)\//;
const MODULE_FILE = /\.(c|m)?[jt]sx?$|\.css$|\.json$/;
const PROVIDER_BOUNDARY_ROOTS = /^packages\/(service|desktop)\/src\//;

const STEP = {
  agentsMd: ["AGENTS.md matches .claude/rules", ["node", "scripts/build-agents-md.mjs", "--check"]],
  providerBoundaries: ["provider boundaries", ["pnpm", "run", "check:provider-boundaries"]],
  rootTests: ["root script tests", ["pnpm", "run", "test:scripts"]],
  releaseTests: ["release script tests", ["pnpm", "run", "test:release-scripts"]],
  rustFormat: ["Rust format", ["pnpm", "--filter", "@cadencr/service", "run", "format:check"]],
  rustLint: ["Rust clippy", ["pnpm", "--filter", "@cadencr/service", "run", "lint"]],
  rustTest: ["Rust tests", ["pnpm", "--filter", "@cadencr/service", "run", "test"]],
};

const step = ([label, command]) => ({ label, command });
const turbo = (tasks, filters) => [
  "pnpm",
  "turbo",
  "run",
  ...tasks,
  ...filters.map((name) => `--filter=${name}`),
  "--log-order=stream",
];

function isDocs(path) {
  if (path.startsWith("docs/") || path === "LICENSE") return true;
  if (path.startsWith(".claude/") || path.startsWith(".agents/")) return /\.mdx?$/.test(path);
  // Markdown inside a package's src/ is content (landing pages, embedded prompts).
  return /\.mdx?$/.test(path) && !/^packages\/[^/]+\/src\//.test(path);
}

/** Map one repository-relative path to the check areas it affects. */
export function classifyPath(path) {
  if (isDocs(path)) return ["docs"];
  if (FULL_ROOT_FILES.has(path) || FULL_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return ["full"];
  }
  const areas = ["other"];
  if (RUST_ROOT_FILES.has(path) || RUST_PACKAGE.test(path)) areas.push("rust");
  const jsPackage = path.match(/^packages\/(desktop|landing|brand)\//)?.[1];
  if (jsPackage) areas.push(jsPackage);
  if (LANDING_READS_DESKTOP.test(path)) areas.push("landing");
  if (path.startsWith("packages/brand/src/")) areas.push("desktop", "landing");
  if (RELEASE_INPUTS.some((pattern) => pattern.test(path))) areas.push("release");
  if (PROVIDER_BOUNDARY_ROOTS.test(path)) areas.push("boundaries");
  return areas;
}

/** Files `vitest related` should trace, relative to packages/desktop. */
function desktopRelatedFiles(entries) {
  return entries
    .filter(({ path, deleted }) => !deleted && MODULE_FILE.test(path))
    .flatMap(({ path }) => {
      if (/^packages\/desktop\/(src|electron)\//.test(path)) {
        return [path.slice("packages/desktop/".length)];
      }
      return path.startsWith("packages/brand/src/") ? [`../${path.slice("packages/".length)}`] : [];
    });
}

function desktopTestSteps(entries) {
  if (entries.some(({ path }) => DESKTOP_FULL_SUITE.test(path))) {
    return [
      { label: "desktop tests (full suite)", command: turbo(["test"], [JS_PACKAGES.desktop]) },
    ];
  }
  const related = desktopRelatedFiles(entries);
  if (related.length === 0) return [];
  return [
    {
      label: `desktop tests related to ${related.length} staged file(s)`,
      command: [
        "pnpm",
        "--filter",
        JS_PACKAGES.desktop,
        "exec",
        "vitest",
        "related",
        "--run",
        "--passWithNoTests",
        ...related,
      ],
    },
  ];
}

function fullPlan(reason) {
  return {
    mode: "full",
    reasons: [reason],
    steps: [
      step(STEP.agentsMd),
      step(STEP.providerBoundaries),
      step(STEP.rootTests),
      step(STEP.releaseTests),
      {
        label: "workspace checks",
        command: turbo(["format:check", "lint", "ts-check", "test", "knip"], []),
      },
    ],
  };
}

function describeAreas(entries) {
  const byArea = new Map();
  for (const { path } of entries) {
    for (const area of classifyPath(path)) {
      if (!byArea.has(area)) byArea.set(area, []);
      byArea.get(area).push(path);
    }
  }
  return byArea;
}

/**
 * Build the ordered check plan for a staged change set.
 * @param {{ path: string, deleted?: boolean }[]} entries staged paths (deleted ones still route)
 * @param {{ full?: boolean }} [options]
 */
export function buildPrecommitPlan(entries, { full = false } = {}) {
  if (full) return fullPlan("CADENCR_PRECOMMIT_FULL=1");
  const byArea = describeAreas(entries);
  const reasons = [...byArea].map(([area, paths]) => {
    const more = paths.length > 1 ? ` (+${paths.length - 1} more)` : "";
    return `${area}: ${paths[0]}${more}`;
  });
  if (byArea.has("full")) return fullPlan(`root tooling changed: ${byArea.get("full")[0]}`);

  const steps = [step(STEP.agentsMd)];
  if (!byArea.has("other")) return { mode: entries.length ? "docs" : "empty", reasons, steps };

  if (byArea.has("boundaries")) steps.push(step(STEP.providerBoundaries));
  steps.push(step(STEP.rootTests));
  if (byArea.has("release")) steps.push(step(STEP.releaseTests));
  if (byArea.has("rust")) steps.push(step(STEP.rustFormat));

  const jsAreas = ["desktop", "landing", "brand"].filter((area) => byArea.has(area));
  if (jsAreas.length > 0) {
    const packages = jsAreas.map((area) => JS_PACKAGES[area]);
    steps.push({
      label: `format, lint, types, knip (${jsAreas.join(", ")})`,
      command: turbo(["format:check", "lint", "ts-check", "knip"], packages),
    });
    const otherTests = packages.filter((name) => name !== JS_PACKAGES.desktop);
    if (otherTests.length > 0) {
      steps.push({
        label: `tests (${otherTests.join(", ")})`,
        command: turbo(["test"], otherTests),
      });
    }
    if (byArea.has("desktop")) steps.push(...desktopTestSteps(entries));
  }
  if (byArea.has("rust")) steps.push(step(STEP.rustLint), step(STEP.rustTest));
  return { mode: "scoped", reasons, steps };
}

/** Child env for the checks: drop the variables git exports to hooks. */
export function checkEnv(env) {
  const next = { ...env };
  // GIT_INDEX_FILE and friends point at this commit's index; a test that runs
  // git in a scratch repository would otherwise read and write the wrong one.
  for (const key of [
    "GIT_INDEX_FILE",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
  ]) {
    delete next[key];
  }
  return next;
}

export function formatCommand(command) {
  return command
    .map((arg) => (/^[\w@%+=:,./*-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.split("\0").filter(Boolean);
}

/** Parse `git diff --name-status -z`: alternating status and path fields. */
export function parseNameStatus(fields) {
  const entries = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    entries.push({ path: fields[index + 1], deleted: fields[index] === "D" });
  }
  return entries;
}

function stagedEntries() {
  return parseNameStatus(git(["diff", "--cached", "--name-status", "--no-renames", "-z"]));
}

function printPlan(plan) {
  console.log(`pre-commit plan (${plan.mode}):`);
  for (const reason of plan.reasons) console.log(`  - ${reason}`);
  plan.steps.forEach(({ label, command }, index) => {
    console.log(`  ${index + 1}. ${label}\n       ${formatCommand(command)}`);
  });
}

export function runPlan(plan) {
  const env = checkEnv(process.env);
  for (const [index, { label, command }] of plan.steps.entries()) {
    console.log(`\n==> [${index + 1}/${plan.steps.length}] ${label}`);
    const result = spawnSync(command[0], command.slice(1), {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`\npre-commit: "${label}" failed (exit ${result.status ?? result.signal}).`);
      console.error(`rerun with:\n  ${formatCommand(command)}`);
      console.error("see the whole plan with: node scripts/pre-commit.mjs --dry-run");
      return result.status ?? 1;
    }
  }
  console.log(`\npre-commit: ${plan.steps.length} check(s) passed.`);
  return 0;
}

function main() {
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    console.error(`pre-commit: unknown argument(s): ${unknown.join(" ")}`);
    console.error(
      "usage: node scripts/pre-commit.mjs [--dry-run]  (CADENCR_PRECOMMIT_FULL=1 for all)",
    );
    return 2;
  }
  const dryRun = process.argv.includes("--dry-run");
  const full = process.env.CADENCR_PRECOMMIT_FULL === "1";
  const plan = buildPrecommitPlan(stagedEntries(), { full });
  printPlan(plan);
  if (dryRun) return 0;
  return runPlan(plan);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`pre-commit: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
