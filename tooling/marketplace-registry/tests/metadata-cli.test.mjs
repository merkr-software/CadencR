import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runRegistry } from "./helpers/native-cli.mjs";

async function packages() {
  const provider = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  const repository = "https://github.com/acme/plugins";
  provider.agent.repository = repository;
  provider.agent.distribution.binary["darwin-aarch64"].archive =
    `${repository}/releases/download/v0.1.0/provider.tar.gz`;
  const host = { publisher: "acme", compatibility: { min_app_version: "0.13.1" } };
  const content = (id) => ({
    id,
    name: id,
    description: "Native diagnostic fixture",
    version: "0.1.0",
    repository,
    license: "MIT",
    distribution: {
      archive: `${repository}/releases/download/v0.1.0/${id}.tar.gz`,
      sha256: "a".repeat(64),
    },
  });
  return [
    { kind: "provider", package: provider },
    { kind: "theme", package: { theme: { ...content("midnight"), document_version: 1 }, host } },
    { kind: "tab", package: { tab: { ...content("files-graph"), api_version: 1 }, host } },
  ];
}

function submission(pkg) {
  return {
    schema_version: 2,
    package: pkg,
    source: {
      repository: "https://github.com/acme/plugins",
      commit: "b".repeat(40),
      tag: "v0.1.0",
    },
    changelog: "Native schema-2 diagnostic fixture",
  };
}

function accepted(command, file) {
  const result = runRegistry([command, file, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ["code", "message", "ok"]);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(JSON.parse(result.stdout).code, "OK");
}

function rejected(command, ...args) {
  const result = runRegistry([command, ...args, "--json"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  const diagnostic = JSON.parse(result.stderr);
  assert.equal(diagnostic.ok, false);
  assert.match(diagnostic.code, /^(REGISTRY_VALIDATION_FAILED|CLI_USAGE_ERROR)$/);
}

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), "registry-native-metadata-"));
  t.after(() => rm(root, { recursive: true }));
  return root;
}

test("real CLI validates standalone schema-2 metadata and submissions for all three kinds", async (t) => {
  const root = await temporary(t);
  for (const pkg of await packages()) {
    const file = path.join(root, `${pkg.kind}.json`);
    const text = JSON.stringify(pkg);
    await writeFile(file, text);
    accepted("validate-metadata", file);
    assert.equal(await readFile(file, "utf8"), text);
    const document = JSON.stringify(submission(pkg));
    await writeFile(file, document);
    accepted("validate-submission", file);
    assert.equal(await readFile(file, "utf8"), document);
    const invalid = submission(pkg);
    invalid.source.repository = "https://github.com/other/owner";
    await writeFile(file, JSON.stringify(invalid));
    rejected("validate-submission", file);
    const nested = { kind: "provider", package: pkg };
    await writeFile(file, JSON.stringify(nested));
    rejected("validate-metadata", file);
    await writeFile(file, JSON.stringify(submission(nested)));
    rejected("validate-submission", file);
  }
});

test("standalone diagnostic CLI rejects malformed, oversized, unreadable and symlinked files", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "input.json");
  for (const command of ["validate-metadata", "validate-submission"]) {
    rejected(command);
    rejected(command, root);
    rejected(command, path.join(root, "missing"));
    await writeFile(file, "{");
    rejected(command, file);
    await writeFile(file, JSON.stringify({ package: {}, source: {}, changelog: "invalid" }));
    rejected(command, file);
  }
  const [provider] = await packages();
  await writeFile(file, JSON.stringify(submission(provider)));
  const link = path.join(root, "link");
  await symlink(file, link);
  rejected("validate-submission", link);
  rejected("validate-metadata", link);
  await writeFile(file, " ".repeat(1024 * 1024 + 1));
  rejected("validate-submission", file);
  await writeFile(file, " ".repeat(32 * 1024 * 1024 + 1));
  rejected("validate-metadata", file);
});
