// Interpreters for the checks, chosen without touching the user's PATH.
//
//   node scripts/toolchain-env.mjs -- <command> [args...]
//
// runs <command> with a Python 3.11+ as `python3` and a Node that satisfies
// `engines.node`. When the ones on PATH already qualify, the environment is
// left as is. Otherwise a private directory holding only `python3` (and, if
// needed, `node`) links goes first on the child's PATH: nothing else on PATH
// moves, so a fix for Python never brings in Homebrew's Node (or the reverse).
// Each set of links gets its own directory, named after its content, so a link
// an earlier run needed can never shadow the PATH of a later one.
// The pre-commit hook and scripts/verify-commits.mjs use `toolchainEnv`.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findInstalledNode, nodeRequirement, satisfiesRange } from "./node-requirement.mjs";
import { choosePython, noPythonMessage, pythonProblem } from "./python-requirement.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

/** Where link sets live: inside node_modules, so per checkout and never committed. */
export const linkRoot = (root) => join(root, "node_modules/.cache/cadencr-toolchain");

/** The directory holding exactly `links`: same links, same directory. Pure. */
export function linkDir(base, links) {
  const content = JSON.stringify(Object.entries(links).sort());
  return join(base, `bin-${createHash("sha256").update(content).digest("hex").slice(0, 12)}`);
}

/**
 * Decide which links the children need. Pure: the probes' results come in.
 * `python` is `choosePython()`'s result. Returns `{ links, notes, errors }`.
 */
export function planToolchain({ nodeVersion, requirement, python, chooseNode }) {
  const links = {};
  const notes = [];
  const errors = [];
  if (pythonProblem(python.onPath) !== null) {
    if (python.chosen) {
      links.python3 = python.chosen.path;
      notes.push(
        `python3 for the checks: ${python.chosen.path} (${python.chosen.version}); PATH has ${describe(python.onPath)}`,
      );
    } else {
      errors.push(noPythonMessage(python.tried));
    }
  }
  if (!satisfiesRange(nodeVersion, requirement.range)) {
    const installed = chooseNode();
    const sameMajor = nodeVersion.split(".")[0] === requirement.nvmrc.split(".")[0];
    if (installed) {
      links.node = join(installed.binDir, "node");
      notes.push(
        `node for the checks: ${installed.version} from ${installed.binDir} (current ${nodeVersion} is outside ${requirement.range})`,
      );
    } else if (sameMajor) {
      notes.push(
        `node ${nodeVersion} is outside ${requirement.range}; install ${requirement.nvmrc} (\`fnm install\` or \`nvm install\` read .nvmrc)`,
      );
    } else {
      errors.push(
        `node ${nodeVersion} is outside ${requirement.range} and no ${requirement.nvmrc} install was found ` +
          "(fnm, nvm, volta, mise, asdf). Node ≥ 25 fails the desktop tests. " +
          `Fix: install Node ${requirement.nvmrc} (\`fnm install\` or \`nvm install\` read .nvmrc).`,
      );
    }
  }
  return { links, notes, errors };
}

function describe(python) {
  return python.version === null
    ? "no runnable python3"
    : `python3 ${python.version} at ${python.path}`;
}

/** Atomically point `<dir>/<name>` at `target`, safe against a concurrent hook. */
function link(dir, name, target) {
  const temporary = join(dir, `.${name}.${process.pid}`);
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, join(dir, name));
}

/** `env` with the directory of `links` (under `base`) first on PATH; unchanged without links. */
export function applyLinks(env, links, base, { makeLink = link } = {}) {
  const names = Object.keys(links);
  if (names.length === 0) return env;
  const dir = linkDir(base, links);
  mkdirSync(dir, { recursive: true });
  for (const name of names) makeLink(dir, name, links[name]);
  return { ...env, PATH: [dir, env.PATH].filter(Boolean).join(delimiter) };
}

/**
 * The child environment for the checks. Throws with every problem when an
 * interpreter is missing; `notes` say what was picked instead of PATH's.
 */
export function toolchainEnv(env, { root = repoRoot } = {}) {
  const plan = planToolchain({
    nodeVersion: process.versions.node,
    requirement: nodeRequirement(root),
    python: choosePython({ env }),
    chooseNode: () => findInstalledNode(nodeRequirement(root)),
  });
  if (plan.errors.length > 0) throw new Error(plan.errors.join("\n"));
  return { env: applyLinks(env, plan.links, linkRoot(root)), notes: plan.notes };
}

function main(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length === 0) {
    console.error("usage: node scripts/toolchain-env.mjs -- <command> [args...]");
    return 2;
  }
  let prepared;
  try {
    prepared = toolchainEnv(process.env);
  } catch (error) {
    console.error(`toolchain: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  for (const note of prepared.notes) console.error(`toolchain: ${note}`);
  const result = spawnSync(args[0], args.slice(1), { env: prepared.env, stdio: "inherit" });
  if (result.error) {
    console.error(`toolchain: ${args[0]}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main(process.argv.slice(2));
}
