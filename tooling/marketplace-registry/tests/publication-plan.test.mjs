import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../scripts/plan-publication.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

function submission() {
  const repository = "https://github.com/acme/provider";
  const target = (name, sha256) => ({
    archive: `${repository}/releases/download/v1.2.3/${name}`,
    cmd: "bin/provider",
    sha256,
  });
  return {
    schema_version: 1,
    package: {
      agent: {
        id: "acme-agent",
        name: "Acme Agent",
        version: "1.2.3",
        description: "ACP connector for Acme",
        license: "Apache-2.0",
        repository,
        distribution: {
          binary: {
            "windows-x86_64": target("provider.zip", "B".repeat(64)),
            "darwin-aarch64": target("provider.tar.gz", "A".repeat(64)),
            "darwin-x86_64": target("provider.tgz", "C".repeat(64)),
            "linux-aarch64": target("provider.tar.bz2", "D".repeat(64)),
            "linux-x86_64": target("provider.tbz2", "E".repeat(64)),
          },
        },
      },
      host: {
        publisher: "acme",
        compatibility: { min_app_version: "0.12.0" },
        assets: { icon: "assets/icon.svg", readme: "README.md", license: "LICENSE" },
      },
    },
    source: { repository, commit: "1".repeat(40), tag: "v1.2.3" },
    changelog: "Release notes.",
  };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "publication-plan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "submission.json");
  const output = path.join(directory, "plan.json");
  const text = JSON.stringify(submission());
  await writeFile(input, text);
  return { directory, input, output, text };
}

test("CLI deterministically plans sorted immutable supported archive mirrors", async (t) => {
  const { input, output, text } = await fixture(t);
  const args = ["--submission", input, "--repository", "cadencr/registry", "--output", output];
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Local plan only/);
  const first = await readFile(output, "utf8");
  const plan = JSON.parse(first);
  assert.equal(plan.schema_version, 1);
  assert.deepEqual(plan.source.submission, submission());
  assert.deepEqual(plan.source.identity, {
    provider_id: "acme-agent",
    version: "1.2.3",
    repository: "https://github.com/acme/provider",
    commit: "1".repeat(40),
    tag: "v1.2.3",
  });
  assert.equal(plan.release.tag, "provider-acme-agent-v1.2.3");
  assert.deepEqual(
    plan.targets.map(({ target, asset }) => [target, asset]),
    [
      ["darwin-aarch64", `darwin-aarch64-${"a".repeat(64)}.tar.gz`],
      ["darwin-x86_64", `darwin-x86_64-${"c".repeat(64)}.tgz`],
      ["linux-aarch64", `linux-aarch64-${"d".repeat(64)}.tar.bz2`],
      ["linux-x86_64", `linux-x86_64-${"e".repeat(64)}.tbz2`],
      ["windows-x86_64", `windows-x86_64-${"b".repeat(64)}.zip`],
    ],
  );
  for (const target of plan.targets) {
    assert.match(
      target.destination_url,
      /^https:\/\/github\.com\/cadencr\/registry\/releases\/download\/provider-acme-agent-v1\.2\.3\//,
    );
    assert.equal(
      plan.mirrored_package.agent.distribution.binary[target.target].archive,
      target.destination_url,
    );
  }
  assert.equal(await readFile(input, "utf8"), text);

  const secondOutput = `${output}.second`;
  assert.equal(run(...args.slice(0, -1), secondOutput).status, 0);
  assert.equal(await readFile(secondOutput, "utf8"), first);
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
});

test("CLI rejects invalid submissions, repositories, arguments, symlinks, and overwrites", async (t) => {
  const { directory, input, output } = await fixture(t);
  const base = ["--submission", input, "--repository", "cadencr/registry", "--output", output];
  assert.equal(run().status, 1);
  for (const flag of ["--submission", "--repository", "--output"]) {
    const args = [...base];
    args[args.indexOf(flag) + 1] = "";
    assert.equal(run(...args).status, 1, `${flag} must reject an empty value`);
  }
  assert.equal(run(...base, "--unknown", "value").status, 1);
  assert.equal(
    run("--submission", input, "--submission", input, "--repository", "a/b", "--output", output)
      .status,
    1,
  );
  for (const repository of [
    "https://github.com/a/b",
    "a/../b",
    "a/b.git",
    "a:b/c",
    "a/b/c",
    "a./b",
  ]) {
    assert.equal(
      run("--submission", input, "--repository", repository, "--output", output).status,
      1,
      repository,
    );
  }

  const invalid = path.join(directory, "invalid.json");
  await writeFile(invalid, "{}");
  assert.equal(run("--submission", invalid, "--repository", "a/b", "--output", output).status, 1);
  const oversized = path.join(directory, "oversized.json");
  await writeFile(oversized, " ".repeat(1024 * 1024 + 1));
  const oversizedResult = run("--submission", oversized, "--repository", "a/b", "--output", output);
  assert.equal(oversizedResult.status, 1);
  assert.match(oversizedResult.stderr, /1 MiB/);
  const link = path.join(directory, "submission-link.json");
  await symlink(input, link);
  assert.equal(run("--submission", link, "--repository", "a/b", "--output", output).status, 1);

  await writeFile(output, "sentinel", { mode: 0o600 });
  assert.equal(run(...base).status, 1);
  assert.equal(await readFile(output, "utf8"), "sentinel");
});

test("CLI rejects raw executables outside the publication archive policy", async (t) => {
  const { input, output } = await fixture(t);
  const value = submission();
  value.package.agent.distribution.binary["darwin-aarch64"].archive =
    `${value.source.repository}/releases/download/v1.2.3/provider.exe`;
  await writeFile(input, JSON.stringify(value));
  const result = run("--submission", input, "--repository", "a/b", "--output", output);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /supported \.tar\.gz, \.tgz, \.tar\.bz2, \.tbz2, or \.zip/);
});
