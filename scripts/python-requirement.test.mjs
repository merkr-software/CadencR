import assert from "node:assert/strict";
import test from "node:test";
import {
  choosePython,
  findPython,
  meetsMinimum,
  noPythonMessage,
  pythonCandidates,
  pythonProblem,
} from "./python-requirement.mjs";

/** A fake filesystem: directory → entry names. */
const lister = (tree) => (dir) => tree[dir] ?? [];

test("meetsMinimum compares major and minor, not strings", () => {
  for (const version of ["3.11.0", "3.12.9", "3.14.5", "4.0.0"]) assert.ok(meetsMinimum(version));
  for (const version of ["3.9.6", "3.10.14", "2.7.18"]) assert.ok(!meetsMinimum(version));
});

test("pythonProblem names the interpreter it judged", () => {
  assert.equal(pythonProblem({ version: "3.12.0", path: "/x" }), null);
  assert.equal(
    pythonProblem({ version: "3.9.6", path: "/usr/bin/python3" }, "/usr/bin/python3"),
    "/usr/bin/python3 3.9.6 at /usr/bin/python3 is older than 3.11",
  );
  assert.match(
    pythonProblem({ version: null, problem: "ENOENT\nmore" }),
    /^python3 not runnable: ENOENT$/,
  );
});

test("macOS: python3 on PATH first, then versioned ones on PATH, then Homebrew, pyenv and uv", () => {
  const home = "/Users/u";
  const candidates = pythonCandidates({
    platform: "darwin",
    home,
    env: { PATH: "/usr/bin:/Users/u/bin" },
    listDir: lister({
      "/usr/bin": ["python3", "python3.9"],
      "/Users/u/bin": ["python3.12", "python3.12-config", "python3.10"],
      "/opt/homebrew/bin": ["python3", "python3.13", "python3.14", "python3.14-config"],
      "/Users/u/.pyenv/versions": ["3.9.18", "3.12.4"],
      "/Users/u/.local/share/uv/python": ["cpython-3.13.1-macos-aarch64-none", ".lock"],
    }),
  });
  assert.deepEqual(candidates, [
    "python3",
    "/Users/u/bin/python3.12",
    "/Users/u/.pyenv/versions/3.12.4/bin/python3",
    "/Users/u/.local/share/uv/python/cpython-3.13.1-macos-aarch64-none/bin/python3",
    "/opt/homebrew/bin/python3.14",
    "/opt/homebrew/bin/python3.13",
  ]);
});

test("Linux: distribution and Linuxbrew python3.1x, honouring PYENV_ROOT and XDG_DATA_HOME", () => {
  const candidates = pythonCandidates({
    platform: "linux",
    home: "/home/u",
    env: { PATH: "/usr/bin", PYENV_ROOT: "/opt/pyenv", XDG_DATA_HOME: "/data" },
    listDir: lister({
      "/usr/bin": ["python3", "python3.10", "python3.11"],
      "/opt/pyenv/versions": ["3.13.0"],
      "/data/uv/python": ["cpython-3.12.2-linux-x86_64-gnu"],
      "/home/linuxbrew/.linuxbrew/bin": ["python3.13"],
    }),
  });
  assert.deepEqual(candidates, [
    "python3",
    "/usr/bin/python3.11",
    "/opt/pyenv/versions/3.13.0/bin/python3",
    "/data/uv/python/cpython-3.12.2-linux-x86_64-gnu/bin/python3",
    "/home/linuxbrew/.linuxbrew/bin/python3.13",
  ]);
  assert.ok(!candidates.includes("/opt/homebrew/bin/python3.13"), "no macOS paths on Linux");
});

test("findPython returns the first compatible candidate and what it skipped", () => {
  const versions = {
    python3: { version: "3.9.6", path: "/usr/bin/python3" },
    "/a/python3.11": { version: null, problem: "spawnSync /a/python3.11 ENOENT" },
    "/b/python3.12": { version: "3.12.1", path: "/b/python3.12" },
    "/c/python3.13": { version: "3.13.0", path: "/c/python3.13" },
  };
  const probed = [];
  const { python, tried } = findPython({
    candidates: Object.keys(versions),
    probe: (command) => {
      probed.push(command);
      return versions[command];
    },
  });
  assert.deepEqual(python, { version: "3.12.1", path: "/b/python3.12", command: "/b/python3.12" });
  assert.deepEqual(
    probed,
    ["python3", "/a/python3.11", "/b/python3.12"],
    "stops at the first match",
  );
  assert.deepEqual(tried, ["python3 3.9.6 at /usr/bin/python3 is older than 3.11"]);
});

test("no compatible interpreter yields a message with what was found and the fix", () => {
  const { python, tried } = findPython({
    candidates: ["python3"],
    probe: () => ({ version: "3.10.2", path: "/usr/bin/python3" }),
  });
  assert.equal(python, null);
  const message = noPythonMessage(tried);
  assert.match(message, /no Python 3\.11\+ found/);
  assert.match(message, /python3 3\.10\.2 at \/usr\/bin\/python3 is older than 3\.11/);
  assert.match(message, /Homebrew/);
  assert.match(message, /without changing your PATH/);
});

test("choosePython keeps a qualifying python3 and probes nothing else", () => {
  const probed = [];
  const probe = (command) => {
    probed.push(command);
    return { version: "3.12.0", path: "/usr/bin/python3" };
  };
  assert.deepEqual(choosePython({ env: { PATH: "" }, probe }), {
    onPath: { version: "3.12.0", path: "/usr/bin/python3" },
    chosen: null,
    tried: [],
  });
  assert.deepEqual(probed, ["python3"]);
});
