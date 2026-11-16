#!/usr/bin/env node
// Which tools carry changes that no release of theirs ships yet. The tools
// are the artifacts released on their own semver, apart from the app: the
// crates.io SDKs, the npm tab packages and the CLI (CONTRIBUTING.md,
// "Releasing the SDKs and the CLI"). Read-only: it never bumps, tags or
// dispatches anything.
//
//   node scripts/release-tools.mjs [--ref <git ref>] [--json] [tool ...]
//
// Everything is read at `--ref` (default `origin/main`, the only ref the
// release workflows publish from), so run `git fetch --tags origin` first.
import { execFileSync } from "node:child_process";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** App releases up to this version also shipped the CLI, under `vX.Y.Z`. */
export const LAST_APP_RELEASE_WITH_CLI = "0.14.0";

export const TOOLS = [
  {
    id: "cadencr-tab-backend",
    kind: "crate",
    dir: "packages/tab-backend-sdk-rs",
    tagPrefix: "cadencr-tab-backend-v",
    workflow: "crates-release.yml",
    inputs: { crate: "cadencr-tab-backend" },
  },
  {
    id: "cadencr-provider-sdk",
    kind: "crate",
    dir: "packages/provider-plugin-sdk-rs",
    tagPrefix: "cadencr-provider-sdk-v",
    workflow: "crates-release.yml",
    inputs: { crate: "cadencr-provider-sdk" },
  },
  {
    id: "tab-sdk",
    kind: "npm",
    dir: "packages/tab-sdk",
    tagPrefix: "tab-sdk-v",
    workflow: "npm-release.yml",
    inputs: { package: "tab-sdk" },
  },
  {
    id: "tab-kit",
    kind: "npm",
    dir: "packages/tab-kit",
    tagPrefix: "tab-kit-v",
    workflow: "npm-release.yml",
    inputs: { package: "tab-kit" },
  },
  {
    id: "cli",
    kind: "cli",
    dir: "packages/cli",
    tagPrefix: "cli/v",
    workflow: "cli-release.yml",
    inputs: { source_commit: "<full origin/main SHA>" },
  },
];

/** Changes that ship in no published artifact. */
const NOT_SHIPPED = [
  ":(exclude,glob)**/*.test.*",
  ":(exclude,glob)**/tests/**",
  ":(exclude,glob)**/test/**",
];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** Negative, zero or positive as `a` sorts before, with or after `b`. */
export function compareSemver(a, b) {
  const [pa, pb] = [SEMVER.exec(a), SEMVER.exec(b)];
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  // A pre-release sorts before its release.
  if (pa[4] === pb[4]) return 0;
  if (pa[4] === undefined) return 1;
  if (pb[4] === undefined) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

/** The `[package]` version of a Cargo manifest. */
export function crateVersion(manifest) {
  const section = manifest.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  return section.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? null;
}

/**
 * The `path` of every dependency that ends up in the built artifact: normal
 * and build dependencies, target-specific ones included, never dev ones.
 */
export function pathDependencies(manifest) {
  const shipped = /^(target\..+\.)?(build-)?dependencies(\.[^.\]]+)?$/;
  const paths = [];
  let inShipped = false;
  for (const line of manifest.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inShipped = shipped.test(header[1].trim());
      continue;
    }
    const path = inShipped && line.match(/\bpath\s*=\s*"([^"]+)"/)?.[1];
    if (path) paths.push(path);
  }
  return paths;
}

/** What a change to the tool's release must cover, besides its tests. */
export function watchedPaths(tool, git) {
  if (tool.kind === "npm") return [tool.dir, "scripts/vendor-tab-packages.mjs"];
  const dirs = new Set();
  const visit = (dir) => {
    if (dirs.has(dir)) return;
    dirs.add(dir);
    for (const path of pathDependencies(git.show(`${dir}/Cargo.toml`))) {
      visit(posix.normalize(posix.join(dir, path)));
    }
  };
  visit(tool.dir);
  // A binary ships its locked dependencies and the toolchain's codegen.
  const extra = tool.kind === "cli" ? ["Cargo.lock", "rust-toolchain.toml"] : [];
  return [...dirs, ...extra];
}

function readVersion(tool, git) {
  if (tool.kind === "npm") return JSON.parse(git.show(`${tool.dir}/package.json`)).version;
  return crateVersion(git.show(`${tool.dir}/Cargo.toml`));
}

/** Records that must equal the tool's version and do not. */
function versionProblems(tool, version, git) {
  const problems = [];
  if (tool.id === "tab-sdk") {
    const sdk = git.show("packages/tab-sdk/src/version.ts").match(/SDK_VERSION = "([^"]+)"/)?.[1];
    if (sdk !== version) problems.push(`SDK_VERSION is ${sdk}, package.json ${version}`);
  }
  if (tool.id === "cli") {
    const npm = JSON.parse(git.show("packages/cli/package.json")).version;
    if (npm !== version) problems.push(`package.json is ${npm}, Cargo.toml ${version}`);
    const locked = git
      .show("Cargo.lock")
      .split(/^\[\[package\]\]\s*$/m)
      .find((entry) => /^name\s*=\s*"cadencr-cli"\s*$/m.test(entry))
      ?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (locked !== version) problems.push(`Cargo.lock is ${locked}, Cargo.toml ${version}`);
  }
  return problems;
}

/** Every release of the tool, as `{tag, version}`. */
export function releases(tool, tags) {
  const found = [];
  for (const tag of tags) {
    if (tag.startsWith(tool.tagPrefix)) {
      const version = tag.slice(tool.tagPrefix.length);
      // `cli/vX.Y.Z-dev.<run>.<attempt>` are development builds, not releases.
      if (SEMVER.test(version) && !version.includes("-dev.")) found.push({ tag, version });
    }
    // The app releases that also shipped the CLI.
    const app = tag.match(/^v(.+)$/)?.[1];
    if (
      tool.kind === "cli" &&
      app &&
      SEMVER.test(app) &&
      compareSemver(app, LAST_APP_RELEASE_WITH_CLI) <= 0
    ) {
      found.push({ tag, version: app });
    }
  }
  return found.sort((a, b) => compareSemver(a.version, b.version));
}

/**
 * - `first-release`: never released;
 * - `ready`: the version was bumped and no release carries it yet;
 * - `needs-bump`: the version is released and changes landed since;
 * - `up-to-date`: the version is released and nothing shipped changed since.
 */
export function toolStatus(tool, git) {
  const version = readVersion(tool, git);
  const all = releases(tool, git.tags());
  const current = all.find((release) => release.version === version) ?? null;
  const older = all.filter((release) => compareSemver(release.version, version) < 0);
  const baseline = current ?? older.at(-1) ?? null;
  const commits = baseline ? git.log(baseline.tag, watchedPaths(tool, git)) : null;
  let state;
  if (current) state = commits.length > 0 ? "needs-bump" : "up-to-date";
  else state = baseline ? "ready" : "first-release";
  return {
    id: tool.id,
    version,
    state,
    released: current?.tag ?? null,
    baseline: baseline?.tag ?? null,
    commits,
    problems: versionProblems(tool, version, git),
    workflow: tool.workflow,
    inputs: tool.inputs,
  };
}

export function gitAt(ref) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    show: (path) => git("show", `${ref}:${path}`),
    tags: () => git("tag", "--list").split("\n").filter(Boolean),
    log: (base, paths) =>
      git("log", "--format=%h%x09%s", `${base}..${ref}`, "--", ...paths, ...NOT_SHIPPED)
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ...subject] = line.split("\t");
          return { sha, subject: subject.join("\t") };
        }),
  };
}

const LABELS = {
  "first-release": "first release: never published",
  ready: "ready: this version is not released yet",
  "needs-bump": "needs a version bump: changed since its release",
  "up-to-date": "up to date",
};

function describe(status) {
  const lines = [`${status.id} ${status.version}: ${LABELS[status.state]}`];
  if (status.commits?.length) {
    lines.push(`  ${status.commits.length} commit(s) since ${status.baseline}:`);
    for (const commit of status.commits) lines.push(`    ${commit.sha} ${commit.subject}`);
  }
  for (const problem of status.problems) lines.push(`  PROBLEM: ${problem}`);
  return lines.join("\n");
}

function main(argv) {
  let ref = "origin/main";
  let json = false;
  const wanted = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--ref") ref = argv[(i += 1)];
    else if (argv[i] === "--json") json = true;
    else wanted.push(argv[i]);
  }
  const unknown = wanted.filter((id) => !TOOLS.some((tool) => tool.id === id));
  if (!ref || unknown.length > 0) {
    console.error(
      `usage: release-tools.mjs [--ref <git ref>] [--json] [${TOOLS.map((t) => t.id).join("|")} ...]`,
    );
    if (unknown.length > 0) console.error(`unknown tool(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  const git = gitAt(ref);
  const tools = wanted.length > 0 ? TOOLS.filter((tool) => wanted.includes(tool.id)) : TOOLS;
  const statuses = tools.map((tool) => toolStatus(tool, git));
  if (json) console.log(JSON.stringify({ ref, statuses }, null, 2));
  else console.log(`Tools at ${ref}:\n\n${statuses.map(describe).join("\n\n")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
