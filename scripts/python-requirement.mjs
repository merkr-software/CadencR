// The CLI qualification and author-CLI QA scripts embed Python 3.11+ code
// (`hashlib.file_digest`, `datetime.fromisoformat` on "…Z" timestamps). With an
// older `python3` first on PATH (macOS ships 3.9 as /usr/bin/python3), their
// tests fail on tracebacks deep in the standard library, which reads like a
// regression. The tests and `pnpm doctor` check the interpreter first instead.
import { spawnSync } from "node:child_process";

export const MIN_PYTHON = "3.11";

export const PYTHON_FIX =
  `install Python ${MIN_PYTHON}+ (Homebrew \`python\`, your distribution's python3 package, ` +
  "uv or pyenv) and put it before any older `python3` on PATH";

const PROBE = "import sys; print('%d.%d.%d' % sys.version_info[:3]); print(sys.executable)";

/** Version and path of the `python3` on PATH, or why it can't be run. */
export function probePython(command = "python3") {
  const result = spawnSync(command, ["-c", PROBE], { encoding: "utf8", timeout: 10_000 });
  if (result.error) return { version: null, problem: result.error.message };
  if (result.status !== 0) {
    return { version: null, problem: (result.stderr || `exit ${result.status}`).trim() };
  }
  const [version, path] = result.stdout.trim().split("\n");
  return { version, path };
}

/** Why `python` can't run the root scripts, or null when it can. Pure. */
export function pythonProblem(python) {
  if (python.version === null) return `python3 not runnable: ${python.problem.split("\n")[0]}`;
  const [major, minor] = python.version.split(".").map(Number);
  const [minMajor, minMinor] = MIN_PYTHON.split(".").map(Number);
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return null;
  return `python3 ${python.version} at ${python.path} is older than ${MIN_PYTHON}`;
}

/**
 * For tests that run the root scripts' Python: fails with the requirement and
 * its fix instead of a standard-library traceback.
 */
export function requirePython() {
  const problem = pythonProblem(probePython());
  if (problem) throw new Error(`${problem}; the root scripts need it: ${PYTHON_FIX}`);
}
