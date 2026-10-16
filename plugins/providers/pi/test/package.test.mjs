import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const script = new URL("../scripts/package.mjs", import.meta.url).pathname;
function packageAt(directory) {
  return spawnSync(process.execPath, [script, "--directory", directory], { encoding: "utf8" });
}
test("packaging refuses stale directory and symlink without modifying either", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-package-refusal-"));
  const stale = join(root, "stale");
  await mkdir(stale);
  await writeFile(join(stale, "sentinel"), "retain");
  assert.notEqual(packageAt(stale).status, 0);
  assert.equal(await readFile(join(stale, "sentinel"), "utf8"), "retain");
  const linked = join(root, "linked");
  await symlink(stale, linked);
  assert.notEqual(packageAt(linked).status, 0);
  assert.equal(await readFile(join(stale, "sentinel"), "utf8"), "retain");
});
test("fresh packaged archive retains executable mode after extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-package-extracted-"));
  const payload = join(root, "payload");
  const result = packageAt(payload);
  assert.equal(result.status, 0, result.stderr);
  const archive = join(root, "payload.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", payload, "."]).status, 0);
  const extracted = join(root, "extracted");
  await mkdir(extracted);
  assert.equal(spawnSync("tar", ["-xzf", archive, "-C", extracted]).status, 0);
  const executable = join(extracted, "bin/provider");
  assert.equal((await stat(executable)).mode & 0o111, 0o111);
  const version = spawnSync(executable, ["version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "0.4.0");
});

test("builder rejects symlink modules instead of using stale shared output", async () => {
  const { buildRuntime } = await import("../scripts/build.mjs");
  const root = await mkdtemp(join(tmpdir(), "pi-build-symlink-"));
  const source = join(root, "src");
  const output = join(root, "output");
  await mkdir(source);
  await mkdir(output);
  await writeFile(join(root, "target.mjs"), "new");
  await symlink(join(root, "target.mjs"), join(source, "provider.mjs"));
  await writeFile(join(output, "provider"), "stale");
  await assert.rejects(
    buildRuntime({ sourceDirectory: source, outputDirectory: output }),
    /regular .mjs/,
  );
  assert.equal(await readFile(join(output, "provider"), "utf8"), "stale");
});

test("packager ignores shared stale bin and rejects a source symlink attack", async () => {
  const { cp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "pi-package-stale-"));
  const candidate = new URL("../", import.meta.url).pathname;
  for (const name of ["src", "scripts", "package.json", "README.md", "LICENSE", "icon.svg"]) {
    await cp(join(candidate, name), join(root, name), { recursive: true });
  }
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin/stale.mjs"), "stale executable content");
  const payload = join(root, "payload");
  const run = (directory) =>
    spawnSync(process.execPath, [join(root, "scripts/package.mjs"), "--directory", directory], {
      encoding: "utf8",
    });
  assert.equal(run(payload).status, 0);
  await assert.rejects(stat(join(payload, "bin/stale.mjs")), /ENOENT/);
  await symlink(join(root, "bin/stale.mjs"), join(root, "src/stale.mjs"));
  const attack = run(join(root, "attack"));
  assert.notEqual(attack.status, 0);
  assert.match(attack.stderr, /regular .mjs/);
  await assert.rejects(stat(join(root, "attack/bin/stale.mjs")), /ENOENT/);
});
