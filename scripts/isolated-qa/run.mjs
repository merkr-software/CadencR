// Run identity and on-disk layout of one isolated QA run (`pnpm qa:up`).
// Everything a run creates lives under its own directory, so `qa:down` can
// remove exactly that and nothing else.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const STATE_FILE = "state.json";
/** Written into every state file; `qa:down` refuses a directory without it. */
export const RUN_MARKER = "cadencr-isolated-qa-run";
export const STATE_VERSION = 1;

/**
 * Where runs are created: `CADENCR_QA_ROOT` when set (an agent points it at its
 * scratchpad), otherwise `$TMPDIR/cadencr-qa`. Never the checkout itself.
 */
export function qaRoot(env = process.env, tmpdir = os.tmpdir()) {
  const explicit = env.CADENCR_QA_ROOT?.trim();
  if (!explicit) return join(tmpdir, "cadencr-qa");
  if (!isAbsolute(explicit)) throw new Error(`CADENCR_QA_ROOT must be absolute: ${explicit}`);
  return explicit;
}

/**
 * The runs root every command uses, canonical (symlinks resolved, e.g. macOS's
 * `/tmp` → `/private/tmp`): run directories and their recorded paths are
 * canonical, so a root reached through a link must resolve to the same place.
 */
export function runsRoot(env = process.env, tmpdir = os.tmpdir()) {
  const root = qaRoot(env, tmpdir);
  return existsSync(root) ? realpathSync(root) : root;
}

/** `20261117-101500-a1b2c3`: sortable, and unique even for runs started in the same second. */
export function newRunId(now = new Date(), suffix = randomBytes(3).toString("hex")) {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `${stamp}-${suffix}`;
}

/** One shell word for any value: printed commands must survive spaces and quotes in paths. */
export function shellQuote(value) {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/** Every path a run owns. Only these are ever created or removed. */
export function runLayout(runDir) {
  return {
    runDir,
    state: join(runDir, STATE_FILE),
    evidence: join(runDir, "evidence.md"),
    screenshots: join(runDir, "screenshots"),
    logs: join(runDir, "logs"),
    // Disposable: removed by `qa:down` (the rest stays for the report unless --purge).
    // `app/` holds the service's state: the settings dir's siblings (plugins,
    // provider installations, trust, caches) land beside it, inside `app/` too.
    app: join(runDir, "app"),
    db: join(runDir, "app", "db"),
    settings: join(runDir, "app", "settings"),
    data: join(runDir, "app", "data"),
    bin: join(runDir, "bin"),
    profile: join(runDir, "browser-profile"),
    project: join(runDir, "project"),
  };
}

export const DISPOSABLE_KEYS = ["app", "bin", "profile", "project"];

export function databasePath(layout) {
  return join(layout.db, "qa.db");
}

/**
 * Create a brand-new private run directory; an existing one is an error, never
 * reused. Its path is canonical (macOS `$TMPDIR` sits behind the `/var` →
 * `/private/var` symlink): git and the service record resolved paths, and
 * `qa:down` matches them against the run's own.
 */
export function createRunDir(root, runId) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const runDir = join(realpathSync(root), runId);
  mkdirSync(runDir, { mode: 0o700 });
  const layout = runLayout(runDir);
  for (const key of ["screenshots", "logs", "app", "db", "settings", "data", "bin", "profile"]) {
    mkdirSync(layout[key], { mode: 0o700 });
  }
  return layout;
}

/** A run id resolves under the QA root; anything with a slash is taken as a run directory. */
export function resolveRunDir(target, root = runsRoot()) {
  if (!target) throw new Error("name the run: its id or its directory");
  const dir = target.includes("/") ? resolve(target) : join(root, target);
  return existsSync(dir) ? realpathSync(dir) : dir;
}

export function writeState(layout, state) {
  const temporary = `${layout.state}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, layout.state);
}

/**
 * Read a run's state and check it describes this very directory, so `qa:down`
 * can never be pointed at an arbitrary folder (or a copied state file).
 */
export function readState(runDir) {
  const file = join(runDir, STATE_FILE);
  if (!existsSync(file)) throw new Error(`${runDir} is not an isolated QA run (no ${STATE_FILE})`);
  const state = JSON.parse(readFileSync(file, "utf8"));
  validateState(state, runDir);
  return state;
}

export function validateState(state, runDir) {
  if (state?.marker !== RUN_MARKER) throw new Error(`${runDir}: not an isolated QA run state`);
  if (state.version !== STATE_VERSION) {
    throw new Error(`${runDir}: state version ${state.version}, expected ${STATE_VERSION}`);
  }
  if (resolve(state.runDir) !== resolve(runDir) || basename(runDir) !== state.runId) {
    throw new Error(`${runDir}: state describes another run (${state.runDir})`);
  }
  if (!isAbsolute(state.runDir) || dirname(state.runDir) === state.runDir) {
    throw new Error(`${runDir}: refusing a run directory at a filesystem root`);
  }
}
