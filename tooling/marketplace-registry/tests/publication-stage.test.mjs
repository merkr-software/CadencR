import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stagePublication } from "../scripts/publication/stage.mjs";

const cli = fileURLToPath(new URL("../scripts/stage-publication.mjs", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function submission(contents = [Buffer.from("one"), Buffer.from("two")]) {
  const repository = "https://github.com/acme/provider";
  const platforms = [
    "darwin-aarch64",
    "linux-x86_64",
    "windows-x86_64",
    "darwin-x86_64",
    "linux-aarch64",
  ];
  const binary = Object.fromEntries(
    contents.map((bytes, index) => [
      platforms[index],
      {
        archive: `${repository}/releases/download/v1/a${index}.tgz`,
        cmd: "bin/provider",
        sha256: digest(bytes),
      },
    ]),
  );
  return {
    schema_version: 1,
    package: {
      agent: {
        id: "acme-agent",
        name: "Acme",
        version: "1.0.0",
        description: "Agent",
        license: "MIT",
        repository,
        distribution: { binary },
      },
      host: {
        publisher: "acme",
        compatibility: { min_app_version: "0.12.0" },
        assets: { icon: "icon.svg", readme: "README.md", license: "LICENSE" },
      },
    },
    source: { repository, commit: "a".repeat(40), tag: "v1" },
    changelog: "Release",
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function downloader(contents, calls, failAt = -1) {
  return async ({ outputPath, sha256 }) => {
    calls.push(sha256);
    if (calls.length === failAt) throw new Error("injected download failure");
    const bytes = contents.find((value) => digest(value) === sha256);
    await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
    return { sha256, size: bytes.length };
  };
}

test("stages deterministic verified artifacts and retries without fetching", async (t) => {
  const root = await fixture(t);
  const contents = [Buffer.from("one"), Buffer.from("two")];
  const calls = [];
  const first = await stagePublication(submission(contents), "cadencr/registry", root, {
    download: downloader(contents, calls),
  });
  assert.equal(first.artifacts.length, 2);
  assert.equal(calls.length, 2);
  const receipt = await readFile(path.join(root, "staging-receipt.json"), "utf8");
  const second = await stagePublication(submission(contents), "cadencr/registry", root, {
    download: async () => assert.fail("must not fetch"),
  });
  assert.deepEqual(second, first);
  assert.equal(await readFile(path.join(root, "staging-receipt.json"), "utf8"), receipt);
  const reordered = submission(contents);
  reordered.source = {
    tag: reordered.source.tag,
    commit: reordered.source.commit,
    repository: reordered.source.repository,
  };
  await stagePublication(reordered, "cadencr/registry", root, {
    download: async () => assert.fail("equivalent reordered input must not fetch"),
  });
  assert.equal(await readFile(path.join(root, "staging-receipt.json"), "utf8"), receipt);
  assert.equal((await lstat(path.join(root, "staging-receipt.json"))).mode & 0o777, 0o600);
});

test("replays a valid receipt larger than one MiB", async (t) => {
  const root = await fixture(t);
  const contents = [Buffer.from("one")];
  const value = submission(contents);
  value.package.agent.description = "x".repeat(600_000);
  await stagePublication(value, "cadencr/registry", root, {
    download: downloader(contents, []),
  });
  assert.ok((await lstat(path.join(root, "staging-receipt.json"))).size > 1024 * 1024);
  await stagePublication(value, "cadencr/registry", root, {
    download: async () => assert.fail("large receipt replay must not fetch"),
  });
});

test("rejects corrupt assets and a receipt for another plan before downloads", async (t) => {
  const contents = [Buffer.from("one")];
  const corrupt = await fixture(t);
  const calls = [];
  await stagePublication(submission(contents), "cadencr/registry", corrupt, {
    download: downloader(contents, calls),
  });
  const receipt = JSON.parse(await readFile(path.join(corrupt, "staging-receipt.json")));
  await rm(path.join(corrupt, "staging-receipt.json"));
  await writeFile(path.join(corrupt, receipt.artifacts[0].asset), "bad");
  await assert.rejects(
    stagePublication(submission(contents), "cadencr/registry", corrupt, {
      download: downloader(contents, calls),
    }),
    /conflicts/,
  );

  const conflict = await fixture(t);
  receipt.plan.repository = "other/registry";
  await writeFile(path.join(conflict, "staging-receipt.json"), JSON.stringify(receipt));
  let fetched = false;
  await assert.rejects(
    stagePublication(submission(contents), "cadencr/registry", conflict, {
      download: async () => {
        fetched = true;
      },
    }),
    /different publication plan/,
  );
  assert.equal(fetched, false);
});

test("preserves completed assets after failure and resumes only missing targets", async (t) => {
  const root = await fixture(t);
  const contents = [Buffer.from("one"), Buffer.from("two")];
  const calls = [];
  await assert.rejects(
    stagePublication(submission(contents), "cadencr/registry", root, {
      download: downloader(contents, calls, 2),
    }),
    /injected/,
  );
  assert.equal(calls.length, 2);
  await stagePublication(submission(contents), "cadencr/registry", root, {
    download: downloader(contents, calls),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual((await lstat(root)).isDirectory(), true);
});

test("refuses concurrent locks and symlink staging directories", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, ".stage.lock"), "foreign");
  await assert.rejects(
    stagePublication(submission([Buffer.from("one")]), "cadencr/registry", root, {
      download: async () => {},
    }),
    /already locked/,
  );
  assert.equal(await readFile(path.join(root, ".stage.lock"), "utf8"), "foreign");
  const target = await fixture(t);
  const link = `${target}-link`;
  t.after(() => rm(link, { force: true }));
  await symlink(target, link);
  await assert.rejects(
    stagePublication(submission([Buffer.from("one")]), "cadencr/registry", link, {
      download: async () => {},
    }),
    /non-symlink directory/,
  );
});

test("CLI strictly rejects missing, extra, malformed, oversized, and symlink input", async (t) => {
  const root = await fixture(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(run().status, 1);
  assert.equal(
    run("--submission", "x", "--repository", "a/b", "--directory", root, "--extra", "x").status,
    1,
  );
  const input = path.join(root, "input.json");
  await writeFile(input, "{");
  assert.equal(
    run("--submission", input, "--repository", "a/b", "--directory", path.join(root, "out")).status,
    1,
  );
  await writeFile(input, " ".repeat(1024 * 1024 + 1));
  assert.match(
    run("--submission", input, "--repository", "a/b", "--directory", path.join(root, "out")).stderr,
    /1 MiB/,
  );
  const valid = path.join(root, "valid.json");
  await writeFile(valid, JSON.stringify(submission([Buffer.from("one")])));
  const link = path.join(root, "link.json");
  await symlink(valid, link);
  assert.equal(
    run("--submission", link, "--repository", "a/b", "--directory", path.join(root, "out")).status,
    1,
  );
});
