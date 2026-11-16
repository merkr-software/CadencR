import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runRegistry } from "./helpers/native-cli.mjs";

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), "registry-native-"));
  t.after(() => rm(root, { recursive: true }));
  return root;
}

function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

const window = () => ({
  generated: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  expires: new Date(Date.now() + 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
});

// This suite exercises the exact executable used by portable registry callers.
// The exhaustive business/negative matrix lives in Rust; see COVERAGE.md.
test("native CLI validates an empty standalone registry without scripts or dependencies", async (t) => {
  const root = await temporary(t);
  for (const tree of ["base", "candidate"]) {
    await mkdir(path.join(root, tree, "packages"), { recursive: true });
    await mkdir(path.join(root, tree, "submissions"));
  }
  success(runRegistry(["validate", "--base", "base", "--candidate", "candidate"], { cwd: root }));
  const { generated, expires } = window();
  const emptyIndex = runRegistry(
    [
      "build-index",
      "--packages",
      "candidate/packages",
      "--generated-at",
      generated,
      "--expires-at",
      expires,
    ],
    { cwd: root },
  );
  assert.notEqual(emptyIndex.status, 0);
  assert.match(emptyIndex.stderr, /non-empty array/);
});

test("native index signing bytes match frozen service bytes and refuse clobbering", async (t) => {
  const root = await temporary(t);
  const packages = path.join(root, "packages");
  await mkdir(packages);
  const fixture = JSON.parse(
    await readFile(new URL("fixtures/valid.json.fixture", import.meta.url), "utf8"),
  );
  const original = JSON.stringify(fixture.signed.packages[0], null, 2);
  const input = path.join(packages, "acme-agent-1.2.3.json");
  await writeFile(input, original);
  const { generated, expires } = window();
  const output = path.join(root, "payload.json");
  const args = [
    "build-index",
    "--packages",
    packages,
    "--generated-at",
    generated,
    "--expires-at",
    expires,
    "--output",
    output,
  ];
  success(runRegistry(args));
  const expected = (
    await readFile(new URL("fixtures/valid.signing.json.fixture", import.meta.url), "utf8")
  )
    .trimEnd()
    .replace("2026-09-12T00:00:00Z", generated)
    .replace("2026-09-19T00:00:00Z", expires);
  assert.equal(await readFile(output, "utf8"), expected);
  assert.equal(await readFile(input, "utf8"), original);
  assert.notEqual(runRegistry(args).status, 0);
  assert.equal(await readFile(output, "utf8"), expected);
});

test("native CLI rejects malformed metadata and unsafe paths without producing output", async (t) => {
  const root = await temporary(t);
  const packages = path.join(root, "packages");
  await mkdir(packages);
  const output = path.join(root, "never-written.json");
  const { generated, expires } = window();
  const args = [
    "build-index",
    "--packages",
    packages,
    "--generated-at",
    generated,
    "--expires-at",
    expires,
    "--output",
    output,
  ];
  const fixture = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  for (const mutate of [
    (value) => {
      value.host.assets.readme = "../README.md";
    },
    (value) => {
      value.host.credentials = "not-allowed";
    },
    (value) => {
      value.agent.id = "../escape";
    },
    (value) => {
      value.agent.distribution.binary["darwin-aarch64"].env = { API_TOKEN: "never" };
    },
  ]) {
    const invalid = structuredClone(fixture);
    mutate(invalid);
    await writeFile(path.join(packages, "example-provider-0.1.0.json"), JSON.stringify(invalid));
    assert.notEqual(runRegistry(args).status, 0);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }
});
