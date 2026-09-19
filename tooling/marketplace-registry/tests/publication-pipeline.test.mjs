import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson, validateSignedIndex } from "../scripts/lib.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("local publication plan feeds the existing signed index contract without remote writes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-publication-pipeline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pkg = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  pkg.agent.repository = "https://github.com/acme/connector";
  pkg.agent.license = "MIT";
  pkg.host.assets.readme = "README.md";
  pkg.host.assets.license = "LICENSE";
  for (const target of Object.values(pkg.agent.distribution.binary)) {
    target.archive = "https://github.com/acme/connector/releases/download/v0.1.0/provider.tar.gz";
  }
  const submission = {
    schema_version: 1,
    package: pkg,
    source: { repository: pkg.agent.repository, commit: "a".repeat(40), tag: "v0.1.0" },
    changelog: "Local integration fixture only.",
  };
  const source = path.join(directory, "submission.json");
  const planFile = path.join(directory, "plan.json");
  await writeFile(source, JSON.stringify(submission));
  const run = (script, args) => {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  };
  run("plan-publication.mjs", [
    "--submission",
    source,
    "--repository",
    "acme/registry",
    "--output",
    planFile,
  ]);
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  assert.deepEqual(plan.source.submission, submission);
  assert.ok(
    plan.targets.every((entry) =>
      entry.destination_url.startsWith("https://github.com/acme/registry/releases/download/"),
    ),
  );
  const payload = {
    schema_version: 1,
    generated_at: new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    expires_at: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    packages: [plan.mirrored_package],
  };
  const payloadFile = path.join(directory, "index.json");
  const keyFile = path.join(directory, "key.pem");
  const output = path.join(directory, "signed.json");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(payloadFile, JSON.stringify(payload));
  await writeFile(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  run("sign-index.mjs", [
    "--payload",
    payloadFile,
    "--private-key",
    keyFile,
    "--key-id",
    "test-only",
    "--output",
    output,
  ]);
  const envelope = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(validateSignedIndex(envelope), []);
  assert.deepEqual(envelope.signed, payload);
  assert.ok(
    verify(
      null,
      Buffer.from(canonicalJson(payload)),
      publicKey,
      Buffer.from(envelope.signature.value, "base64"),
    ),
  );
  assert.deepEqual(JSON.parse(await readFile(source, "utf8")), submission);
});
