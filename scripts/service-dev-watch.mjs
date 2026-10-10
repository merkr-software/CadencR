// Rebuild and restart `cadencr-service` whenever its sources change.
//
// Run through `scripts/cargo-env.mjs` (see `@cadencr/service#dev`) so
// CARGO_TARGET_DIR is pinned to this worktree. Prefers `watchexec` and falls
// back to `cargo-watch` (unmaintained). Besides the service's own `src` and
// `migrations` (embedded at compile time by `sqlx::migrate!`), it watches every
// path-dependency crate (the SDKs, cli-discovery, vendored crates) so editing
// an SDK restarts the service too.
//
// Importing this module has no side effects; scripts/doctor.mjs reuses its
// watcher detection.

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const serviceDir = join(repoRoot, "packages", "service");

export const RUN_ARGS = ["run", "--bin", "cadencr-service"];
export const WATCHEXEC_INSTALL =
  "`cargo install watchexec-cli --locked` or `brew install watchexec`";
export const INSTALL_HINT =
  "service-dev-watch: neither `watchexec` nor `cargo-watch` is on PATH.\n" +
  `Install one: ${WATCHEXEC_INSTALL}.`;

/**
 * Local `path = "..."` dependencies declared in a Cargo.toml. Dev-dependencies
 * are skipped: they never end up in the `cargo run` binary.
 */
export function parsePathDependencies(cargoToml) {
  const paths = [];
  let inDependencyTable = false;
  for (const rawLine of cargoToml.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const header = line.match(/^\[+([^\]]+)\]+$/);
    if (header) {
      const name = header[1].replace(/\s+/g, "");
      inDependencyTable = /(^|\.)(build-)?dependencies(\.|$)/.test(name);
      continue;
    }
    if (!inDependencyTable) continue;
    const path = line.match(/\bpath\s*=\s*"([^"]+)"/);
    if (path) paths.push(path[1]);
  }
  return paths;
}

/** Every crate directory reachable from `crateDir` through path dependencies. */
export function collectPathDependencyDirs(crateDir, readManifest) {
  const seen = new Set();
  const pending = [crateDir];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const dep of parsePathDependencies(readManifest(join(dir, "Cargo.toml")))) {
      const depDir = resolve(dir, dep);
      if (seen.has(depDir) || depDir === crateDir) continue;
      seen.add(depDir);
      pending.push(depDir);
    }
  }
  return [...seen].sort();
}

/** Paths to watch, relative to the service dir (the watcher's cwd). */
export function buildWatchPaths({ repoRoot: root, serviceDir: service, dependencyDirs }) {
  const absolute = [
    join(service, "src"),
    join(service, "migrations"),
    join(service, ".env"),
    join(service, "Cargo.toml"),
    join(root, "Cargo.toml"),
    join(root, "Cargo.lock"),
    ...dependencyDirs.flatMap((dir) => [join(dir, "src"), join(dir, "Cargo.toml")]),
  ];
  return [...new Set(absolute)].map((path) => relative(service, path) || ".");
}

/** The full watcher invocation for `tool` ("watchexec" | "cargo-watch"). */
export function buildWatchCommand(tool, watchPaths) {
  if (tool === "watchexec") {
    return {
      command: "watchexec",
      args: [
        "--restart",
        // `.env` is gitignored; only explicitly watched paths are observed, so
        // honouring ignore files would only hide that one.
        "--no-project-ignore",
        ...watchPaths.flatMap((path) => ["--watch", path]),
        "--",
        "cargo",
        ...RUN_ARGS,
      ],
    };
  }
  if (tool === "cargo-watch") {
    return {
      command: "cargo",
      args: [
        "watch",
        "--no-vcs-ignores",
        ...watchPaths.flatMap((path) => ["-w", path]),
        "-x",
        RUN_ARGS.join(" "),
      ],
    };
  }
  throw new Error(`unknown watcher: ${tool}`);
}

/** First available watcher, given a `hasExecutable(name)` predicate. */
export function pickWatcher(hasExecutable) {
  if (hasExecutable("watchexec")) return "watchexec";
  if (hasExecutable("cargo-watch")) return "cargo-watch";
  return null;
}

/** Absolute path of the first executable `name` on PATH (PATHEXT on Windows), or null. */
export function executableOnPath(name, env = process.env, platform = process.platform) {
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      const stat = statSync(candidate, { throwIfNoEntry: false });
      if (stat?.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0)) {
        return candidate;
      }
    }
  }
  return null;
}

function main() {
  const tool = pickWatcher((name) => executableOnPath(name));
  if (tool === null) {
    console.error(INSTALL_HINT);
    process.exit(1);
  }

  const dependencyDirs = collectPathDependencyDirs(serviceDir, (path) =>
    readFileSync(path, "utf8"),
  );
  const watchPaths = buildWatchPaths({ repoRoot, serviceDir, dependencyDirs });
  const { command, args } = buildWatchCommand(tool, watchPaths);
  if (tool === "cargo-watch") {
    console.warn("service-dev-watch: using cargo-watch (unmaintained); prefer watchexec.");
  }

  const child = spawn(command, args, { cwd: serviceDir, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`service-dev-watch: failed to start ${command}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal === "SIGINT" ? 130 : 143));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main();
}
