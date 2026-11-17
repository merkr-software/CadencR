import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { applyLinks, linkDir, planToolchain, toolchainEnv } from "./toolchain-env.mjs";

const REQUIREMENT = { range: ">=22.19.0 <23.0.0", nvmrc: "22.19.0" };
const OLD = { version: "3.9.6", path: "/usr/bin/python3" };
const NEW = { version: "3.14.5", path: "/opt/homebrew/bin/python3.14" };
const FINE = { onPath: NEW, chosen: null, tried: [] };
const unused = () => assert.fail("not consulted");

const plan = (overrides) =>
  planToolchain({
    nodeVersion: "22.19.0",
    requirement: REQUIREMENT,
    python: FINE,
    chooseNode: unused,
    ...overrides,
  });

test("interpreters already on PATH that qualify need no link", () => {
  assert.deepEqual(plan({}), { links: {}, notes: [], errors: [] });
});

test("an old python3 on PATH is replaced for the children only by the one found", () => {
  const result = plan({ python: { onPath: OLD, chosen: NEW, tried: [] } });
  assert.deepEqual(result.links, { python3: NEW.path });
  assert.match(
    result.notes[0],
    /python3 for the checks: \/opt\/homebrew\/bin\/python3\.14 \(3\.14\.5\)/,
  );
  assert.match(result.notes[0], /PATH has python3 3\.9\.6 at \/usr\/bin\/python3/);
  assert.deepEqual(result.errors, []);
});

test("no compatible Python is an error that lists what was found", () => {
  const tried = ["python3 3.9.6 at /usr/bin/python3 is older than 3.11"];
  const result = plan({ python: { onPath: OLD, chosen: null, tried } });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /no Python 3\.11\+ found.*3\.9\.6/s);
});

test("a Node outside engines uses the .nvmrc install, never another major", () => {
  const nvmrc = { version: "22.19.0", binDir: "/fnm/v22.19.0/installation/bin" };
  const result = plan({ nodeVersion: "22.18.0", chooseNode: () => nvmrc });
  assert.deepEqual(result.links, { node: "/fnm/v22.19.0/installation/bin/node" });
  assert.match(result.notes[0], /current 22\.18\.0 is outside/);

  const sameMajor = plan({ nodeVersion: "22.18.0", chooseNode: () => null });
  assert.deepEqual(sameMajor.links, {});
  assert.deepEqual(sameMajor.errors, [], "same major: warn and keep going");
  assert.match(sameMajor.notes[0], /install 22\.19\.0/);

  const homebrew = plan({ nodeVersion: "26.1.0", chooseNode: () => null });
  assert.match(homebrew.errors[0], /node 26\.1\.0 is outside .*Node ≥ 25 fails the desktop tests/s);
});

test("each set of links has its own directory, first on PATH, the rest of PATH kept", () => {
  const base = mkdtempSync(join(tmpdir(), "cadencr-toolchain-"));
  try {
    const env = { PATH: "/usr/bin:/bin", HOME: "/h" };
    assert.equal(applyLinks(env, {}, base), env);
    const both = { python3: "/opt/py/python3.12", node: "/fnm/22.19.0/node" };
    const next = applyLinks(env, both, base);
    const [dir, ...rest] = next.PATH.split(delimiter);
    assert.equal(dir, linkDir(base, both));
    assert.equal(rest.join(delimiter), "/usr/bin:/bin");
    assert.equal(next.HOME, "/h");
    assert.equal(readlinkSync(join(dir, "python3")), "/opt/py/python3.12");
    // A later run needing only python3 must not inherit the earlier node link.
    const pythonOnly = applyLinks(env, { python3: "/opt/py/python3.12" }, base);
    const onlyDir = pythonOnly.PATH.split(delimiter)[0];
    assert.notEqual(onlyDir, dir);
    assert.equal(existsSync(join(onlyDir, "node")), false);
    // The same set (another hook in the same checkout) reuses its directory.
    assert.equal(applyLinks(env, both, base).PATH, next.PATH);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** An executable that answers the version probe like the given Python would. */
function fakePython(path, version) {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n%s\\n' '${version}' "$0"\n`);
  chmodSync(path, 0o755);
}

test("end to end: children see a compatible python3 and the same node", () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-toolchain-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ engines: { node: ">=18" } }));
    writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`);
    const old = join(root, "old");
    const versioned = join(root, "versioned");
    mkdirSync(old);
    mkdirSync(versioned);
    fakePython(join(old, "python3"), "3.9.6");
    fakePython(join(versioned, "python3.12"), "3.12.1");
    const env = { PATH: [old, versioned, "/usr/bin", "/bin"].join(delimiter), HOME: root };

    const prepared = toolchainEnv(env, { root });
    assert.match(prepared.notes.join("\n"), /python3\.12 \(3\.12\.1\)/);
    const python = spawnSync("python3", ["-c", "probe"], { env: prepared.env, encoding: "utf8" });
    assert.equal(python.stdout.split("\n")[0], "3.12.1");
    const node = spawnSync("sh", ["-c", "command -v node || true"], {
      env: prepared.env,
      encoding: "utf8",
    });
    assert.equal(node.stdout.trim(), "", "no node link: PATH's own (here none) is kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
