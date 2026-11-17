// `pnpm doctor`: check that this checkout can run `pnpm dev`, with a fix per
// problem. Exits non-zero when any check is an error. `gatherFacts` does all
// the probing; `evaluate` is pure and unit-tested in scripts/doctor.test.mjs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBundleProblem } from "../packages/desktop/scripts/ensure-electron-lib.mjs";
import {
  DESKTOP_ENV,
  REQUIRED_SERVICE_KEYS,
  SERVICE_ENV,
  isPlaceholderToken,
  portMismatches,
  readEnvFile,
} from "./dev-env.mjs";
import { gitCheckout } from "./git-worktrees.mts";
import { nodeRequirement, satisfiesRange } from "./node-requirement.mjs";
import { MIN_PYTHON, choosePython, noPythonMessage, pythonProblem } from "./python-requirement.mjs";
import { WATCHEXEC_INSTALL, executableOnPath, pickWatcher } from "./service-dev-watch.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

const ok = (title) => ({ status: "ok", title });
const warn = (title, fix) => ({ status: "warn", title, fix });
const error = (title, fix) => ({ status: "error", title, fix });

function toolchainChecks({ node, pnpm, deps }) {
  const checks = [];
  checks.push(
    satisfiesRange(node.version, node.range)
      ? ok(`Node ${node.version} (requires ${node.range})`)
      : error(
          `Node ${node.version} does not satisfy ${node.range}`,
          `install Node ${node.nvmrc} and select it with \`fnm use\` or \`nvm use\` (both read .nvmrc); ` +
            "`fnm env --use-on-cd` switches automatically when you cd into the repo",
        ),
  );
  if (pnpm.version === null) {
    checks.push(error(`pnpm not runnable: ${pnpm.problem}`, "run `corepack enable`"));
  } else if (pnpm.version !== pnpm.expected) {
    checks.push(
      error(
        `pnpm ${pnpm.version}, but packageManager pins ${pnpm.expected}`,
        "run `corepack enable` so the pinned pnpm is used (or `corepack install`)",
      ),
    );
  } else {
    checks.push(ok(`pnpm ${pnpm.version}`));
  }
  checks.push(
    deps.installed
      ? ok("workspace dependencies installed")
      : error("node_modules missing", "run `pnpm install`"),
  );
  return checks;
}

/**
 * Not needed by `pnpm dev`, but the root script tests (pre-commit, CI) need it.
 * The hooks pick a compatible interpreter themselves (scripts/toolchain-env.mjs),
 * so an old `python3` first on PATH is fine when another one qualifies.
 */
function pythonCheck({ python }) {
  if (pythonProblem(python.onPath) === null) {
    return ok(`python3 ${python.onPath.version} (root script tests need ${MIN_PYTHON}+)`);
  }
  if (python.chosen) {
    return ok(
      `the hooks run Python ${python.chosen.version} from ${python.chosen.path} ` +
        `(${pythonProblem(python.onPath)})`,
    );
  }
  return warn(
    "no Python for the root script tests: pre-commit will stop before running them",
    noPythonMessage(python.tried),
  );
}

function rustChecks(facts) {
  return [...rustToolchainChecks(facts), watcherCheck(facts)];
}

function rustToolchainChecks({ rust }) {
  const checks = [];
  if (rust.toolchain === null) {
    checks.push(
      error(
        `no usable Rust toolchain: ${rust.problem}`,
        "install rustup (https://rustup.rs), then run `rustup toolchain install` in the repo root",
      ),
    );
  } else {
    checks.push(ok(`Rust toolchain ${rust.toolchain}`));
    const missing = ["rustfmt", "clippy"].filter(
      (name) => !rust.components.some((component) => component.startsWith(name)),
    );
    checks.push(
      missing.length === 0
        ? ok("rustfmt and clippy installed")
        : error(
            `missing Rust components: ${missing.join(", ")}`,
            `run \`rustup component add ${missing.join(" ")}\``,
          ),
    );
  }
  return checks;
}

function watcherCheck({ watcher }) {
  const fix = `install watchexec: ${WATCHEXEC_INSTALL}`;
  if (watcher.tool === "watchexec") return ok(`watchexec at ${watcher.path}`);
  if (watcher.tool === "cargo-watch") {
    return warn(`service watcher: cargo-watch at ${watcher.path} (watchexec preferred)`, fix);
  }
  return error("no Rust file watcher: `pnpm dev` cannot restart the service", fix);
}

/**
 * Existence and required keys of the two `.env` files. A debug service refuses
 * to start without them, even when every value comes from its CLI flags.
 */
function envPresenceChecks({ env, linkedWorktree }) {
  const setup = linkedWorktree ? "pnpm dev:configure-worktree" : "pnpm setup:dev";
  const checks = [];
  for (const [path, values] of [
    [SERVICE_ENV, env.service],
    [DESKTOP_ENV, env.desktop],
  ]) {
    checks.push(values ? ok(`${path} exists`) : error(`${path} is missing`, `run \`${setup}\``));
  }
  if (env.service) {
    const missing = REQUIRED_SERVICE_KEYS.filter((key) => !env.service[key]?.trim());
    if (missing.length > 0) {
      checks.push(
        error(
          `${SERVICE_ENV} lacks ${missing.join(", ")}`,
          `copy them from ${SERVICE_ENV}.example`,
        ),
      );
    }
  }
  return checks;
}

function envFileChecks({ env, linkedWorktree, gitProblem }) {
  const checks = [];
  if (gitProblem) {
    checks.push(
      warn(
        `cannot tell whether this checkout is a linked worktree: ${gitProblem}`,
        "the fixes below assume a main checkout; check that `git rev-parse --git-dir` works here",
      ),
    );
  }
  checks.push(...envPresenceChecks({ env, linkedWorktree }));
  if (!env.service || !env.desktop) return checks;

  const serviceToken = env.service.CADENCR_AUTH_TOKEN;
  const desktopToken = env.desktop.VITE_API_TOKEN;
  if (isPlaceholderToken(serviceToken) || isPlaceholderToken(desktopToken)) {
    checks.push(
      error(
        "dev token is still a placeholder",
        linkedWorktree
          ? "run `pnpm setup:dev` in the main checkout, then rerun `pnpm dev:configure-worktree` here"
          : "run `pnpm setup:dev` to generate one",
      ),
    );
  } else if (serviceToken !== desktopToken) {
    checks.push(
      error(
        "CADENCR_AUTH_TOKEN and VITE_API_TOKEN differ: every request will 401",
        linkedWorktree
          ? `set VITE_API_TOKEN in ${DESKTOP_ENV} to the service token, or rerun \`pnpm dev:configure-worktree\``
          : "run `pnpm setup:dev --fix-token`",
      ),
    );
  } else {
    checks.push(ok("dev tokens match"));
  }
  const ports = portMismatches(env.service, env.desktop);
  checks.push(
    ports.length === 0
      ? ok(
          `ports agree (renderer ${env.desktop.VITE_FRONTEND_PORT}, service ${env.service.CADENCR_RUST_PORT})`,
        )
      : error(
          `port mismatch: ${ports.join("; ")}`,
          linkedWorktree
            ? "rerun `pnpm dev:configure-worktree`"
            : "edit the two .env files so they agree",
        ),
  );
  return checks;
}

function electronCheck({ electron }) {
  return electron.installed
    ? ok("Electron binary present")
    : error(
        `Electron binary missing: ${electron.problem}`,
        "run `pnpm --filter @cadencr/desktop ensure:electron`",
      );
}

/** Turn probed facts into ordered check results. Pure. */
export function evaluate(facts) {
  return [
    ...toolchainChecks(facts),
    pythonCheck(facts),
    ...rustChecks(facts),
    ...envFileChecks(facts),
    electronCheck(facts),
  ];
}

/**
 * The subset an isolated QA run (`pnpm qa:up`) depends on. It brings its own
 * ports, token and database, so the `.env` values, the file watcher and Python
 * do not matter; the toolchain, the `.env` files themselves and Electron do.
 */
export function evaluateForQa(facts, { electron }) {
  return [
    ...toolchainChecks(facts),
    ...rustToolchainChecks(facts),
    ...envPresenceChecks(facts),
    ...(electron ? [electronCheck(facts)] : []),
  ];
}

export function formatReport(checks) {
  const lines = ["Cadencr doctor"];
  for (const { status, title, fix } of checks) {
    lines.push(`  ${status.padEnd(5)}  ${title}`);
    if (fix) lines.push(`         fix: ${fix}`);
  }
  const count = (status) => checks.filter((check) => check.status === status).length;
  lines.push("", `${count("error")} error(s), ${count("warn")} warning(s)`);
  return lines.join("\n");
}

function probe(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    // Probing must not trigger downloads or toolchain installs (nor wait on a
    // corepack download prompt).
    env: {
      ...process.env,
      RUSTUP_AUTO_INSTALL: "0",
      COREPACK_ENABLE_NETWORK: "0",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    },
  });
  if (result.error) return { ok: false, output: result.error.message };
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output: result.status === 0 ? result.stdout.trim() : output };
}

const message = (cause) => (cause instanceof Error ? cause.message : String(cause));

function electronFacts(root) {
  try {
    const require = createRequire(join(root, "packages/desktop/package.json"));
    const electronModulePath = dirname(require.resolve("electron/package.json"));
    const problem = electronBundleProblem({ electronModulePath });
    return problem === null ? { installed: true } : { installed: false, problem };
  } catch (cause) {
    return { installed: false, problem: message(cause) };
  }
}

function checkoutFacts(root) {
  try {
    return { linkedWorktree: gitCheckout(root).linkedWorktree, gitProblem: null };
  } catch (cause) {
    return { linkedWorktree: false, gitProblem: message(cause).split("\n")[0] };
  }
}

function watcherFacts() {
  const tool = pickWatcher((name) => executableOnPath(name));
  return { tool, path: tool && executableOnPath(tool) };
}

function rustFacts() {
  const toolchain = probe("rustup", ["show", "active-toolchain"]);
  if (!toolchain.ok)
    return { toolchain: null, components: [], problem: toolchain.output.split("\n")[0] };
  const components = probe("rustup", ["component", "list", "--installed"]);
  if (!components.ok)
    return { toolchain: null, components: [], problem: components.output.split("\n")[0] };
  // "stable-… (overridden by '/abs/path/rust-toolchain.toml')" -> "stable-… (rust-toolchain.toml)"
  const name = toolchain.output.split("\n")[0].replace(/\(overridden by '.*\/([^/]+)'\)/, "($1)");
  return { toolchain: name, components: components.output.split("\n") };
}

export function gatherFacts(root = repoRoot) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pnpm = probe("pnpm", ["--version"]);
  return {
    node: { version: process.versions.node, ...nodeRequirement(root) },
    pnpm: {
      version: pnpm.ok ? pnpm.output.split("\n").at(-1) : null,
      problem: pnpm.output.split("\n")[0],
      expected: pkg.packageManager.replace(/^pnpm@/, "").replace(/\+.*$/, ""),
    },
    deps: { installed: existsSync(join(root, "node_modules/.modules.yaml")) },
    python: choosePython(),
    rust: rustFacts(),
    watcher: watcherFacts(),
    env: { service: readEnvFile(root, SERVICE_ENV), desktop: readEnvFile(root, DESKTOP_ENV) },
    ...checkoutFacts(root),
    electron: electronFacts(root),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const checks = evaluate(gatherFacts());
    console.log(formatReport(checks));
    process.exitCode = checks.some((check) => check.status === "error") ? 1 : 0;
  } catch (cause) {
    console.error(`doctor: ${message(cause)}`);
    process.exitCode = 1;
  }
}
