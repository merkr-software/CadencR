import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const registry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(registry, "scripts/validate-contribution.mjs");

function packageValue(id = "acme-agent", version = "1.0.0") {
  return {
    agent: {
      id,
      name: "Acme Agent",
      version,
      description: "ACP connector",
      license: "Apache-2.0",
      repository: "https://github.com/acme/acme-agent",
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive: `https://github.com/acme/acme-agent/releases/download/v${version}/agent.tar.gz`,
            cmd: "bin/agent",
            sha256: "a".repeat(64),
          },
        },
      },
    },
    host: {
      publisher: "acme",
      compatibility: { min_app_version: "0.12.0" },
      assets: { icon: "icon.svg", readme: "README.md", license: "LICENSE" },
    },
  };
}

function submission(pkg) {
  return {
    schema_version: 1,
    package: pkg,
    source: {
      repository: pkg.agent.repository,
      commit: "0123456789abcdef0123456789abcdef01234567",
      tag: `v${pkg.agent.version}`,
    },
    changelog: "Release notes.",
  };
}

async function fixture(t, basePackages = [], baseSubmissions = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "contribution-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = path.join(root, "base");
  const candidate = path.join(root, "candidate");
  for (const directory of [base, candidate])
    await mkdir(path.join(directory, "packages"), { recursive: true });
  for (const [name, value] of basePackages) {
    await put(base, "packages", name, value);
    await put(candidate, "packages", name, value);
  }
  for (const [name, value] of baseSubmissions) {
    await put(base, "submissions", name, value);
    await put(candidate, "submissions", name, value);
  }
  return { root, base, candidate };
}

async function put(root, directory, name, value) {
  await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, directory, name), JSON.stringify(value));
}

function run(base, candidate, extra = []) {
  return spawnSync(process.execPath, [cli, "--base", base, "--candidate", candidate, ...extra], {
    encoding: "utf8",
  });
}

test("accepts a new provider, a subsequent version, and unchanged legacy packages", async (t) => {
  const legacy = packageValue("legacy-agent");
  legacy.agent.repository = "https://github.com/acme/acme-agent";
  const first = await fixture(t, [["legacy-agent-1.0.0.json", legacy]]);
  assert.equal(run(first.base, first.candidate).status, 0);

  const fresh = packageValue();
  await put(first.candidate, "packages", "acme-agent-1.0.0.json", fresh);
  await put(first.candidate, "submissions", "acme-agent-1.0.0.json", submission(fresh));
  assert.equal(run(first.base, first.candidate).status, 0);

  const second = await fixture(
    t,
    [["acme-agent-1.0.0.json", fresh]],
    [["acme-agent-1.0.0.json", submission(fresh)]],
  );
  const next = packageValue("acme-agent", "1.1.0");
  await put(second.candidate, "packages", "acme-agent-1.1.0.json", next);
  await put(second.candidate, "submissions", "acme-agent-1.1.0.json", submission(next));
  assert.equal(run(second.base, second.candidate).status, 0);
});

test("rejects edits and removals of existing packages and submissions", async (t) => {
  const pkg = packageValue();
  const value = submission(pkg);
  const { base, candidate } = await fixture(
    t,
    [["acme-agent-1.0.0.json", pkg]],
    [["acme-agent-1.0.0.json", value]],
  );
  const edited = structuredClone(pkg);
  edited.agent.description = "rewritten";
  await put(candidate, "packages", "acme-agent-1.0.0.json", edited);
  await writeFile(path.join(candidate, "submissions", "acme-agent-1.0.0.json"), "{}");
  const result = run(base, candidate);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /existing packages are immutable/);
  assert.match(result.stderr, /existing submissions are immutable/);

  const removed = await fixture(
    t,
    [["acme-agent-1.0.0.json", pkg]],
    [["acme-agent-1.0.0.json", value]],
  );
  const empty = path.join(removed.root, "empty");
  await mkdir(path.join(empty, "packages"), { recursive: true });
  const deletion = run(removed.base, empty);
  assert.match(deletion.stderr, /deletion is not allowed/);
});

test("rejects missing, mismatched, orphan, and retroactive submissions", async (t) => {
  const { base, candidate } = await fixture(t);
  const pkg = packageValue();
  await put(candidate, "packages", "acme-agent-1.0.0.json", pkg);
  assert.match(run(base, candidate).stderr, /new package versions require/);

  const wrong = structuredClone(pkg);
  wrong.agent.description = "Does not match the package file";
  await put(candidate, "submissions", "acme-agent-1.0.0.json", submission(wrong));
  const mismatch = run(base, candidate);
  assert.match(mismatch.stderr, /must exactly match/);

  const orphan = packageValue("orphan-agent");
  await put(candidate, "submissions", "orphan-agent-1.0.0.json", submission(orphan));
  assert.match(run(base, candidate).stderr, /orphan submission/);

  const legacy = await fixture(t, [["acme-agent-1.0.0.json", pkg]]);
  await put(legacy.candidate, "submissions", "acme-agent-1.0.0.json", submission(pkg));
  assert.match(run(legacy.base, legacy.candidate).stderr, /retroactive provenance claims/);
});

test("rejects ownership drift and normalized provider collisions", async (t) => {
  const old = packageValue("acme-agent");
  const { base, candidate } = await fixture(t, [["acme-agent-1.0.0.json", old]]);
  const next = packageValue("acme-agent", "2.0.0");
  next.host.publisher = "attacker";
  next.agent.repository = "https://github.com/attacker/acme-agent";
  const claim = submission(next);
  await put(candidate, "packages", "acme-agent-2.0.0.json", next);
  await put(candidate, "submissions", "acme-agent-2.0.0.json", claim);
  const drift = run(base, candidate);
  assert.match(drift.stderr, /host.publisher must remain/);
  assert.match(drift.stderr, /source.repository must remain/);

  const collision = packageValue("acmeagent", "1.0.0");
  await put(candidate, "packages", "acmeagent-1.0.0.json", collision);
  await put(candidate, "submissions", "acmeagent-1.0.0.json", submission(collision));
  assert.match(run(base, candidate).stderr, /collides.*runtime normalization/);
});

test("keeps ownership consistent across multiple versions introduced in one contribution", async (t) => {
  const valid = await fixture(t);
  for (const version of ["1.0.0", "1.1.0"]) {
    const pkg = packageValue("acme-agent", version);
    await put(valid.candidate, "packages", `acme-agent-${version}.json`, pkg);
    await put(valid.candidate, "submissions", `acme-agent-${version}.json`, submission(pkg));
  }
  assert.equal(run(valid.base, valid.candidate).status, 0);

  const split = await fixture(t);
  const first = packageValue("acme-agent", "1.0.0");
  const second = packageValue("acme-agent", "1.1.0");
  second.host.publisher = "other";
  second.agent.repository = "https://github.com/other/acme-agent";
  await put(split.candidate, "packages", "acme-agent-1.0.0.json", first);
  await put(split.candidate, "submissions", "acme-agent-1.0.0.json", submission(first));
  await put(split.candidate, "packages", "acme-agent-1.1.0.json", second);
  await put(split.candidate, "submissions", "acme-agent-1.1.0.json", submission(second));
  const result = run(split.base, split.candidate);
  assert.match(result.stderr, /host.publisher must remain/);
  assert.match(result.stderr, /source.repository must remain/);
});

test("bounds inert JSON reads and rejects malformed files, symlinks, and invalid paths", async (t) => {
  const { root, base, candidate } = await fixture(t);
  await writeFile(path.join(candidate, "packages", ".gitkeep"), "");
  assert.equal(run(base, candidate).status, 0);
  assert.notEqual(spawnSync(process.execPath, [cli], { encoding: "utf8" }).status, 0);
  assert.notEqual(run(base, candidate, ["extra"]).status, 0);

  await writeFile(path.join(candidate, "packages", "bad.json"), "{");
  assert.match(run(base, candidate).stderr, /invalid JSON/);
  await writeFile(path.join(candidate, "packages", "bad.json"), "x".repeat(1024 * 1024 + 1));
  assert.match(run(base, candidate).stderr, /file limit/);
  await symlink(
    path.join(candidate, "packages", "bad.json"),
    path.join(candidate, "packages", "link.json"),
  );
  assert.match(run(base, candidate).stderr, /symlinks and special files are forbidden/);

  const missing = path.join(root, "missing");
  assert.match(run(missing, candidate).stderr, /base:/);
  const linked = path.join(root, "linked");
  await symlink(candidate, linked);
  assert.match(run(base, linked).stderr, /symlinks are forbidden/);
});

test("never executes contributor-controlled candidate scripts", async (t) => {
  const { root, base, candidate } = await fixture(t);
  const marker = path.join(root, "executed");
  await mkdir(path.join(candidate, "scripts"));
  await writeFile(
    path.join(candidate, "scripts", "validate-contribution.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad");`,
  );
  assert.equal(run(base, candidate).status, 0);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("counts malformed JSON toward the aggregate root byte budget", async (t) => {
  const { base, candidate } = await fixture(t);
  const oneMiB = "x".repeat(1024 * 1024);
  for (let index = 0; index < 33; index += 1) {
    await writeFile(path.join(candidate, "packages", `bad-${index}.json`), oneMiB);
  }
  const result = run(base, candidate);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /root exceeds the 33554432-byte JSON total limit/);
});
