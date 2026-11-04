import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, cpSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { lspFixture, lspTag, preparationFiles } from "./official-plugin-lsp-fixtures.mjs";
import { fixture as authorFixture } from "./official-plugin-author-fixtures.mjs";

test("official LSP closed archive, tag, policy and packaging boundaries", () => {
  const result = spawnSync("python3", ["-B", "scripts/test_official_plugin_lsp.py"], {
    encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("LSP Git-blob reconstruction preserves qualified metadata and all three canonical archives", () => {
  const fixture = lspFixture();
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const release = JSON.parse(readFileSync(join(result.output, "release.json")));
  assert.equal(release.plugin, "lsp-typescript-language-server");
  assert.equal(release.tag, lspTag);
  assert.equal(release.archives.length, 3);
  assert.deepEqual(readFileSync(join(result.output, "package.json")), readFileSync(fixture.entry.package));
  for (const archive of release.archives) {
    assert.equal(archive.sha256, "295472a5ede14af100e3a0fb0eb121d71d2818ee05399ffb3dac3290b0ec7286");
    assert.equal(archive.size, 5014231);
  }
  fixture.entry.release_notes += " source-only drift";
  fixture.files["plugins/release-policy.json"] = JSON.stringify(fixture.policy);
  // Candidate Git policy changes while the trusted checkout policy remains fixed.
  writeFileSync(join(fixture.root, "files.json"), JSON.stringify({ files: fixture.files, modes: fixture.modes }));
  const rejected = fixture.run();
  assert.notEqual(rejected.status, 0);
  assert.equal(existsSync(rejected.output), false);
  assert.match(rejected.stderr, /differs from the trusted release policy/);
});

test("protected author reconstruction admits only the policy-bound flat LSP tag and reviewed notes", () => {
  const author = authorFixture();
  author.approve();
  const source = lspFixture();
  source.policy.publication = "APPROVED";
  source.save();
  writeFileSync(join(author.root, "plugins/release-policy.json"), source.files["plugins/release-policy.json"]);
  for (const name of preparationFiles)
    cpSync(resolve("scripts", name), join(author.root, "scripts", name));
  cpSync(join(source.root, "mock/git"), join(author.root, "mock/git"));
  const fetch = join(author.root, "tooling/marketplace-registry/scripts/ci");
  mkdirSync(fetch, { recursive: true });
  writeFileSync(join(fetch, "fetch-released-cli.sh"), `#!/bin/sh\nprintf '%s\\n' '${source.root}/cli'\n`);
  const first = author.stage("0".repeat(64), lspTag);
  assert.equal(first.status, 0, first.stderr);
  const request = JSON.parse(readFileSync(join(first.output, "request.json")));
  assert.equal(request.tag, lspTag);
  assert.equal(request.release_notes, source.entry.release_notes);
  assert.equal(request.additional_archives.length, 2);
  const repeated = author.stage(first.stdout.trim(), lspTag);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stdout, first.stdout);
  assert.notEqual(author.stage("0".repeat(64), "lsp-other-v0.1.0").status, 0);
});
