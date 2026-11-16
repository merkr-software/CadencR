import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRegistry } from "./helpers/native-cli.mjs";

const timestamp = (hours) =>
  new Date(Date.now() + hours * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
const envelope = (hours, payload = {}) => ({
  signed: { ...payload, generated_at: timestamp(-24), expires_at: timestamp(hours) },
  signature: {},
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "registry-native-expiry-"));
  t.after(() => rm(root, { recursive: true }));
  const file = join(root, "metadata.json");
  return { root, file, put: (value) => writeFile(file, JSON.stringify(value)) };
}

function report(result, expected) {
  assert.equal(result.status, expected === "healthy" ? 0 : 1, result.stdout + result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "stdout must contain exactly one report, not a success trailer");
  const value = JSON.parse(lines[0]);
  assert.equal(value.diagnostic_only, true);
  assert.equal(value.results[0].authenticated, false);
  assert.equal(value.results[0].status, expected);
  if (expected === "healthy") assert.equal(result.stderr, "");
  else {
    const diagnostic = JSON.parse(result.stderr);
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.code, "METADATA_RENEWAL_DUE");
  }
}

test("Rust expiry CLI reports relative healthy, default renewal, expired and explicit warning policy", async (t) => {
  const { file, put } = await fixture(t);
  for (const [hours, expected] of [
    [96, "healthy"],
    [48, "renewal-due"],
    [-1, "expired"],
  ]) {
    await put(envelope(hours));
    report(runRegistry(["check-metadata-expiry", file, "--json"]), expected);
  }
  await put(envelope(48));
  report(
    runRegistry(["check-metadata-expiry", file, "--warning-hours", "24", "--json"]),
    "healthy",
  );
});

test("Rust expiry CLI remains unauthenticated for catalogs and both domain policy envelopes", async (t) => {
  const { file, put } = await fixture(t);
  for (const payload of [
    { schema_version: 2, packages: [] },
    { schema_version: 1, kind: "theme-blocklist", entries: [] },
    { schema_version: 1, kind: "provider-blocklist", entries: [] },
  ]) {
    await put(envelope(96, payload));
    report(runRegistry(["check-metadata-expiry", file, "--json"]), "healthy");
  }
});

test("Rust expiry CLI fails closed on malformed, impossible, future and unsafe metadata", async (t) => {
  const { root, file, put } = await fixture(t);
  const fails = (...args) => {
    const result = runRegistry(["check-metadata-expiry", ...args, "--json"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).ok, false);
  };
  for (const value of [
    {},
    { signed: [], signature: {} },
    { signed: {}, signature: [] },
    { signed: { generated_at: timestamp(-24), expires_at: "2026-02-30T00:00:00Z" }, signature: {} },
    { signed: { generated_at: timestamp(1), expires_at: timestamp(96) }, signature: {} },
    { signed: { generated_at: timestamp(-1), expires_at: timestamp(-1) }, signature: {} },
  ]) {
    await put(value);
    fails(file);
  }
  await writeFile(file, "{");
  fails(file);
  await symlink(file, join(root, "link"));
  fails(join(root, "link"));
  fails(root);
  fails(join(root, "missing"));
  fails();
  fails(file, file, file, file);
  for (const hours of ["0", "337", "not-a-number"]) fails(file, "--warning-hours", hours);
  await writeFile(file, Buffer.alloc(32 * 1024 * 1024 + 1));
  fails(file);
});
