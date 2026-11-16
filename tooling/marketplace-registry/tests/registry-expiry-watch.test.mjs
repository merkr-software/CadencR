import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { registryCli, runRegistry } from "./helpers/native-cli.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const { parse } = require("yaml");
const source = readFileSync(
  new URL("../.github/workflows/watch-registry-expiry.yml", import.meta.url),
  "utf8",
);
const workflow = parse(source);
const script = new URL("../scripts/ci/registry-feeds.sh", import.meta.url).pathname;
const job = workflow.jobs.watch;

test("watch runs daily or on manual dispatch only", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  const [minute, hour, day, month, weekday] = workflow.on.schedule[0].cron.split(" ");
  assert.match(minute, /^\d+$/);
  assert.match(hour, /^\d+$/);
  assert.deepEqual([day, month, weekday], ["*", "*", "*"]);
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.doesNotMatch(source, /\binputs\.|pull_request|push:/);
});

test("watch is read-only, secret-free and writes nothing", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(job.permissions, undefined);
  assert.equal(job.environment, undefined);
  const serialized = JSON.stringify(workflow);
  for (const forbidden of [
    "secrets.",
    "GITHUB_TOKEN",
    "CADENCR_REGISTRY_PRIVATE_KEY",
    "CADENCR_REGISTRY_GITHUB_TOKEN",
    "id-token",
    "contents: write",
    "upload-artifact",
    "publish-registry",
    "materialize-key",
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
  // Not part of the publication lane: it cannot block, or be blocked by, a publisher.
  assert.equal(workflow.concurrency, undefined);
  assert.equal(job["timeout-minutes"], 10);
});

test("watch is inert until configured, then every step runs and failures are not masked", () => {
  const gate = job.steps.find((step) => step.id === "gate");
  assert.match(gate.run, /registry-feeds\.sh gate watch/);
  const after = job.steps.slice(job.steps.indexOf(gate) + 1);
  assert.deepEqual(
    after.map((step) => step.if),
    Array(after.length).fill("steps.gate.outputs.configured == 'true'"),
  );
  assert.equal(JSON.stringify(workflow).includes("continue-on-error"), false);
  assert.doesNotMatch(source, /\|\| true|\|\| exit 0|set \+e/);
  for (const name of [
    "CADENCR_REGISTRY_CATALOG_URL",
    "CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL",
    "CADENCR_REGISTRY_THEME_BLOCKLIST_URL",
    "CADENCR_REGISTRY_TAB_BLOCKLIST_URL",
  ])
    assert.equal(gate.env[name], `\${{ vars.${name} }}`);
});

test("watch uses the exact pinned released CLI and pinned actions", () => {
  const selector = job.steps.find((step) => step.id === "runtime");
  assert.equal(selector.run, "sh scripts/ci/select-publisher-runtime.sh");
  const check = job.steps.find((step) => step.name === "Check expiry and signatures");
  assert.equal(check.env.VERIFIED_CLI, "${{ steps.runtime.outputs.cli_file }}");
  const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkout.with, { ref: "${{ github.sha }}", "persist-credentials": false });
  for (const action of source.matchAll(/uses: ([^\n ]+)/g))
    assert.match(action[1], /@[a-f0-9]{40}$/);
  assert.doesNotMatch(source, /npm|pnpm|yarn|scripts\/[\w-]+\.mjs|cargo|releases\/download/);
  const names = job.steps.map((step) => step.name ?? step.uses);
  assert.ok(
    names.indexOf("Select verified released CLI") <
      names.indexOf("Download public catalog and policies"),
  );
  assert.ok(
    names.indexOf("Download public catalog and policies") <
      names.indexOf("Check expiry and signatures"),
  );
});

test("watch gate needs all four feeds plus the key once the catalog URL is set", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "expiry-gate-"));
  try {
    const feed = (name) =>
      `https://raw.githubusercontent.com/acme/registry/refs/heads/marketplace-v2/${name}`;
    const full = {
      CADENCR_REGISTRY_CATALOG_URL: feed("managed-index.json"),
      CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL: feed("managed-blocklist.json"),
      CADENCR_REGISTRY_THEME_BLOCKLIST_URL: feed("managed-theme-blocklist.json"),
      CADENCR_REGISTRY_TAB_BLOCKLIST_URL: feed("managed-tab-blocklist.json"),
      CADENCR_REGISTRY_KEY_ID: "registry-key-1",
      CADENCR_REGISTRY_PUBLIC_KEY_PEM: "pem",
    };
    const run = (vars) => {
      const output = path.join(root, `output-${Math.random()}`);
      writeFileSync(output, "");
      const env = { ...process.env, GITHUB_OUTPUT: output };
      for (const key of Object.keys(env)) if (key.startsWith("CADENCR_REGISTRY_")) delete env[key];
      const result = spawnSync("sh", [script, "gate", "watch"], {
        encoding: "utf8",
        env: { ...env, ...vars },
      });
      return { result, output: readFileSync(output, "utf8") };
    };
    const inert = run({});
    assert.equal(inert.result.status, 0, inert.result.stderr);
    assert.equal(inert.output, "configured=false\n");
    assert.match(inert.result.stdout, /::notice /);
    assert.equal(run(full).output, "configured=true\n");
    for (const name of Object.keys(full).slice(1)) {
      const { [name]: _removed, ...partial } = full;
      const failed = run(partial);
      assert.notEqual(failed.result.status, 0, name);
      assert.match(failed.result.stderr, new RegExp(name));
      assert.equal(failed.output, "", name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- real Rust CLI: timestamp diagnostic and signature checks -------------

const stamp = (hours) =>
  new Date(Math.floor(Date.now() / 1000) * 1000 + hours * 3600000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

function signedSnapshot(t, remaining = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "expiry-watch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" });
  writeFileSync(
    path.join(root, "private.pem"),
    keys.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  writeFileSync(path.join(root, "public.pem"), publicKey);
  const window = (hours) => ({ generated_at: stamp(-2), expires_at: stamp(hours) });
  const snapshot = path.join(root, "snapshot");
  mkdirSync(snapshot);
  const sign = (command, payload, name) => {
    // The signer refuses stale payloads, so an expired feed is signed by hand.
    if (Date.parse(payload.expires_at) <= Date.now()) {
      const canonical = (value) =>
        Array.isArray(value)
          ? `[${value.map(canonical).join(",")}]`
          : value && typeof value === "object"
            ? `{${Object.keys(value)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
                .join(",")}}`
            : JSON.stringify(value);
      const value = signBytes(null, Buffer.from(canonical(payload)), keys.privateKey);
      writeFileSync(
        path.join(snapshot, name),
        JSON.stringify({
          signed: payload,
          signature: {
            algorithm: "ed25519",
            key_id: "registry-key-1",
            value: value.toString("base64"),
          },
        }),
      );
      return;
    }
    const input = path.join(root, `${name}.payload.json`);
    writeFileSync(input, JSON.stringify(payload));
    const result = runRegistry([
      command,
      "--payload",
      input,
      "--private-key",
      path.join(root, "private.pem"),
      "--key-id",
      "registry-key-1",
      "--output",
      path.join(snapshot, name),
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  // A tiny valid mixed catalog from the template's own example package.
  const built = runRegistry([
    "build-index",
    "--schema-version",
    "2",
    "--packages",
    new URL("../packages", import.meta.url).pathname,
    "--generated-at",
    window(remaining.catalog ?? 200).generated_at,
    "--expires-at",
    window(remaining.catalog ?? 200).expires_at,
    "--output",
    path.join(root, "catalog.payload.json"),
  ]);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  sign(
    "sign-index",
    JSON.parse(readFileSync(path.join(root, "catalog.payload.json"), "utf8")),
    "managed-index.json",
  );
  sign(
    "sign-theme-blocklist",
    { schema_version: 1, kind: "theme-blocklist", entries: [], ...window(remaining.theme ?? 200) },
    "managed-theme-blocklist.json",
  );
  sign(
    "sign-tab-blocklist",
    { schema_version: 1, kind: "tab-blocklist", entries: [], ...window(remaining.tab ?? 200) },
    "managed-tab-blocklist.json",
  );
  sign(
    "sign-provider-blocklist",
    { schema_version: 1, entries: [], ...window(remaining.provider ?? 200) },
    "managed-blocklist.json",
  );
  return { root, snapshot, publicKey, keys };
}

function check({ root, snapshot, publicKey }) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("CADENCR_REGISTRY_")) delete env[key];
  return spawnSync("sh", [script, "check-expiry", snapshot], {
    encoding: "utf8",
    env: {
      ...env,
      VERIFIED_CLI: registryCli(),
      KEY_DIR: path.join(root, "key"),
      CADENCR_REGISTRY_KEY_ID: "registry-key-1",
      CADENCR_REGISTRY_PUBLIC_KEY_PEM: publicKey.trim(),
    },
  });
}

test("check-expiry passes when every feed has more than 72 hours and verifies", (t) => {
  const result = check(signedSnapshot(t));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /verified signed index/);
});

test("check-expiry fails when any single feed has 72 hours or less, or is expired", (t) => {
  for (const feed of ["catalog", "provider", "theme", "tab"]) {
    for (const hours of [48, 71, 72]) {
      const result = check(signedSnapshot(t, { [feed]: hours }));
      assert.notEqual(result.status, 0, `${feed} at ${hours}h`);
      assert.match(result.stdout, /::error title=Registry metadata needs renewal::/);
    }
  }
  const expired = check(signedSnapshot(t, { provider: -1 }));
  assert.notEqual(expired.status, 0);
  assert.match(expired.stderr, /METADATA_RENEWAL_DUE/);
});

test("check-expiry fails on a tampered, mis-keyed, missing or unreadable feed", (t) => {
  const tampered = signedSnapshot(t);
  const file = path.join(tampered.snapshot, "managed-theme-blocklist.json");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace('"entries":[]', '"entries":[{"theme_id":"x","reason":"y"}]'),
  );
  const bad = check(tampered);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /managed-theme-blocklist\.json did not verify/);

  const wrongKey = signedSnapshot(t);
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" });
  assert.notEqual(check({ ...wrongKey, publicKey: other }).status, 0);

  const missing = signedSnapshot(t);
  rmSync(path.join(missing.snapshot, "managed-tab-blocklist.json"));
  assert.notEqual(check(missing).status, 0);

  const garbage = signedSnapshot(t);
  writeFileSync(path.join(garbage.snapshot, "managed-blocklist.json"), "not json");
  assert.notEqual(check(garbage).status, 0);
});

test("check-expiry verifies the provider policy's signature and domain, not just its window", (t) => {
  const tampered = signedSnapshot(t);
  const file = path.join(tampered.snapshot, "managed-blocklist.json");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      '"entries":[]',
      '"entries":[{"provider_id":"x","reason":"y"}]',
    ),
  );
  const bad = check(tampered);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /managed-blocklist\.json did not verify/);

  // A correctly signed theme policy is not a provider policy.
  const swapped = signedSnapshot(t);
  writeFileSync(
    path.join(swapped.snapshot, "managed-blocklist.json"),
    readFileSync(path.join(swapped.snapshot, "managed-theme-blocklist.json")),
  );
  const wrongDomain = check(swapped);
  assert.notEqual(wrongDomain.status, 0);
  assert.match(wrongDomain.stdout, /managed-blocklist\.json did not verify/);

  // The provider policy signed by a different key does not verify with the pinned one.
  const foreign = signedSnapshot(t);
  assert.notEqual(
    check({
      ...foreign,
      publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }),
    }).status,
    0,
  );
});
