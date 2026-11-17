// The CLI qualification and author-CLI QA scripts embed Python 3.11+ code
// (`hashlib.file_digest`, `datetime.fromisoformat` on "…Z" timestamps). With an
// older `python3` first on PATH (macOS ships 3.9 as /usr/bin/python3), their
// tests fail on tracebacks deep in the standard library, which reads like a
// regression.
//
// This module is the single source of truth for that requirement: the
// pre-commit hook and the scripts that run Python pick a compatible
// interpreter with `findPython` (see scripts/toolchain-env.mjs), `pnpm doctor`
// reports the same choice, and the tests check it before running Python.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { listDirOrEmpty, xdgDataHome } from "./node-requirement.mjs";

export const MIN_PYTHON = "3.11";

export const PYTHON_FIX =
  `install Python ${MIN_PYTHON}+ (Homebrew \`python\`, your distribution's python3.1x package, ` +
  "uv or pyenv); the hooks find it as python3 on PATH, a python3.1x on PATH, or in the usual " +
  "Homebrew, pyenv, uv and /usr locations, without changing your PATH";

const PROBE = "import sys; print('%d.%d.%d' % sys.version_info[:3]); print(sys.executable)";
const VERSIONED = /^python3\.(\d+)$/;

/** Version and path of `command` (default: the `python3` on PATH), or why it can't be run. */
export function probePython(command = "python3", env = process.env) {
  const result = spawnSync(command, ["-c", PROBE], { encoding: "utf8", env, timeout: 10_000 });
  if (result.error) return { version: null, problem: result.error.message };
  if (result.status !== 0) {
    return { version: null, problem: (result.stderr || `exit ${result.status}`).trim() };
  }
  const [version, path] = result.stdout.trim().split("\n");
  return { version, path };
}

/** Whether `version` ("3.12.1") meets MIN_PYTHON. Pure. */
export function meetsMinimum(version) {
  const [major, minor] = version.split(".").map(Number);
  const [minMajor, minMinor] = MIN_PYTHON.split(".").map(Number);
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/** Why `python` can't run the root scripts, or null when it can. Pure. */
export function pythonProblem(python, name = "python3") {
  if (python.version === null) return `${name} not runnable: ${python.problem.split("\n")[0]}`;
  if (meetsMinimum(python.version)) return null;
  return `${name} ${python.version} at ${python.path} is older than ${MIN_PYTHON}`;
}

/**
 * Directories that hold Python installs outside PATH, most specific first:
 * pyenv and uv keep one directory per version, Homebrew and Linux distributions
 * install versioned `python3.1x` next to an older default `python3`.
 */
export function wellKnownPythonDirs({ env, home, platform }) {
  const pyenvRoot = env.PYENV_ROOT || join(home, ".pyenv");
  const xdgData = xdgDataHome(env, home);
  const common = [
    { dir: join(pyenvRoot, "versions"), perVersion: true },
    { dir: join(env.UV_PYTHON_INSTALL_DIR || join(xdgData, "uv/python")), perVersion: true },
    { dir: join(home, ".local/bin") },
  ];
  const system =
    platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin"]
      : [
          "/home/linuxbrew/.linuxbrew/bin",
          join(home, ".linuxbrew/bin"),
          "/usr/local/bin",
          "/usr/bin",
        ];
  return [...common, ...system.map((dir) => ({ dir }))];
}

const pythonVersionOf = (name) => Number(name.match(VERSIONED)?.[1] ?? -1);

/** Sort "3.9.18" / "cpython-3.12.4-…" directory names by the version they hold, newest first. */
const versionKey = (name) =>
  (name.match(/(\d+)\.(\d+)(?:\.(\d+))?/) ?? []).slice(1).filter(Boolean).map(Number);

function newestFirst(a, b) {
  const [left, right] = [versionKey(a), versionKey(b)];
  for (let index = 0; index < 3; index += 1) {
    const delta = (right[index] || 0) - (left[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Interpreters to try, in order: `python3` on PATH (what the scripts call),
 * then versioned `python3.1x` on PATH, then the well-known install locations.
 * Within one directory the newest version comes first. Pure apart from
 * `listDir`, which returns a directory's entry names (or [] when unreadable).
 */
export function pythonCandidates({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  listDir = listDirOrEmpty,
} = {}) {
  const [, minMinor] = MIN_PYTHON.split(".").map(Number);
  const versionedIn = (dir) =>
    listDir(dir)
      .filter((name) => pythonVersionOf(name) >= minMinor)
      .sort((a, b) => pythonVersionOf(b) - pythonVersionOf(a))
      .map((name) => join(dir, name));
  const candidates = ["python3"];
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) candidates.push(...versionedIn(dir));
  for (const { dir, perVersion } of wellKnownPythonDirs({ env, home, platform })) {
    if (!perVersion) {
      candidates.push(...versionedIn(dir));
      continue;
    }
    // pyenv: versions/3.12.4/bin; uv: python/cpython-3.12.4-macos-aarch64-none/bin.
    const versions = listDir(dir)
      .filter((name) => versionKey(name).length >= 2 && meetsMinimum(versionKey(name).join(".")))
      .sort(newestFirst);
    for (const version of versions) candidates.push(join(dir, version, "bin/python3"));
  }
  return [...new Set(candidates)];
}

/**
 * The first compatible interpreter among `candidates`, plus every one tried
 * (for the error message). `probe` defaults to running each candidate.
 */
export function findPython({ candidates = pythonCandidates(), probe = probePython } = {}) {
  const tried = [];
  for (const command of candidates) {
    const python = probe(command);
    const problem = pythonProblem(python, command);
    if (problem === null) return { python: { ...python, command }, tried };
    // Only report candidates that exist; most well-known paths are absent.
    if (python.version !== null || command === "python3") tried.push(problem);
  }
  return { python: null, tried };
}

/**
 * What the hooks will run: `onPath` is PATH's `python3`; when it does not
 * qualify, `chosen` is the first compatible interpreter elsewhere (or null)
 * and `tried` lists what was rejected. The one place that decides it.
 */
export function choosePython({ env = process.env, probe = probePython } = {}) {
  const onPath = probe("python3", env);
  if (pythonProblem(onPath) === null) return { onPath, chosen: null, tried: [] };
  const { python, tried } = findPython({
    candidates: pythonCandidates({ env }).filter((candidate) => candidate !== "python3"),
    probe: (command) => probe(command, env),
  });
  return { onPath, chosen: python, tried: [pythonProblem(onPath), ...tried] };
}

/** The error for `findPython` coming back empty. Pure. */
export function noPythonMessage(tried) {
  const seen = tried.length > 0 ? ` Found: ${tried.join("; ")}.` : "";
  return `no Python ${MIN_PYTHON}+ found for the root scripts.${seen} Fix: ${PYTHON_FIX}.`;
}

/**
 * For tests that run the root scripts' Python as `python3`: fails with the
 * requirement and its fix instead of a standard-library traceback. Run them
 * through `pnpm run test:scripts` (or the pre-commit hook), which puts a
 * compatible python3 first for the run.
 */
export function requirePython() {
  const problem = pythonProblem(probePython());
  if (problem) {
    throw new Error(
      `${problem}; run the root script tests through \`pnpm run test:scripts\`, which picks a ` +
        `compatible interpreter, or ${PYTHON_FIX}`,
    );
  }
}
