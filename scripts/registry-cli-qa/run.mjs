import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guard, file, local, sha, VERSION, BINARY_SHA, REPOSITORY } from "./guard.mjs";
import {
  bytes,
  inventory,
  preserved,
  continuity,
  inventoryHash,
  childEnvironment,
  expectedDiscovery,
  initialObservation,
  replayUnchanged,
  archiveCoverage,
  failureDiagnostic,
} from "./evidence.mjs";
const env = process.env;
const { plan, request } = guard();
const helperHashes = {
  "fault-driver.mjs": "bc714592e717c12e1d992d7d04e85eb791f14022391b8db52b5998a7ebdf4da9",
  "fault-proxy.mjs": "f85bf7807edcf3e14f8a2e79c8a4d6322ed8c3ff19c962e67ebc1ac96c941338",
  "evidence.mjs": "57ff31556ee87708a8fcb197e635513e4ee3fc0013d91c1131fd0648836471ba",
};
for (const [name, digest] of Object.entries(helperHashes))
  assert.equal(sha(file(`scripts/${name}`)), digest);
const { interruptPublication } = await import(pathToFileURL(resolve("scripts/fault-driver.mjs")));
const { waitForObservation, assertX8664Elf } = await import(
  pathToFileURL(resolve("scripts/evidence.mjs"))
);
const binary = join(env.RUNNER_TEMP, "qa-cli/cadencr");
const binaryBytes = file(binary, 256 * 1024 * 1024);
assert.equal(sha(binaryBytes), BINARY_SHA);
assertX8664Elf(binaryBytes);
function cli(args, timeout = 900000, authenticated = false) {
  const result = spawnSync(binary, args[0] === "--version" ? args : ["--json", ...args], {
    env: childEnvironment(env, authenticated),
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 1048576,
  });
  assert.ok(
    !result.error && result.status === 0,
    `distributed CLI failed: ${JSON.stringify(failureDiagnostic(result))}`,
  );
  return result.stdout;
}
assert.equal(cli(["--version"], 30000), `cadencr ${VERSION}\n`);
function verify(path) {
  cli(
    [
      "registry",
      "verify-index",
      "--index",
      path,
      "--public-key",
      plan.public_key,
      "--key-id",
      request.key_id,
    ],
    60000,
  );
}
verify(plan.previous);
const readInventory = (signal) => inventory(env.CADENCR_REGISTRY_GITHUB_TOKEN, signal);
const before =
  env.QA_RUNNER === "fresh"
    ? await waitForObservation(
        readInventory,
        (observed) => inventoryHash(observed) === env.QA_EXPECTED_INVENTORY_SHA256,
      )
    : await readInventory();
const initialBaseline = initialObservation(
  before,
  env.QA_RUNNER,
  sha(file(plan.previous)),
  env.QA_EXPECTED_INVENTORY_SHA256,
);
if (env.QA_RUNNER === "first" && plan.phase === "incremental") {
  for (const tag of plan.mirror_tags)
    assert.ok(!before.releases.some((r) => r.tag === tag), "new fixture tag already exists");
}
const root = join(env.RUNNER_TEMP, "qa-public");
const state = join(env.RUNNER_TEMP, "qa-state");
const key = join(env.RUNNER_TEMP, "qa-private.pem");
mkdirSync(root, { mode: 0o700 });
mkdirSync(state, { mode: 0o700 }); // No restored state: fresh runner is independently replayed.
assert.ok(env.QA_SIGNING_KEY_PEM && Buffer.byteLength(env.QA_SIGNING_KEY_PEM) <= 16384);
writeFileSync(key, env.QA_SIGNING_KEY_PEM, { flag: "wx", mode: 0o600 });
delete env.QA_SIGNING_KEY_PEM;
const args = [
  "registry",
  "publish-registry",
  "--request",
  plan.request,
  "--directory",
  state,
  "--repository",
  REPOSITORY,
  "--registry-commit",
  env.REVIEWED_COMMIT,
  "--private-key",
  key,
  "--confirm-request-sha256",
  env.REQUEST_SHA256,
];
try {
  let interrupted;
  if (plan.fault && env.QA_RUNNER === "first") {
    assert.equal(plan.phase, "incremental");
    interrupted = await interruptPublication({
      binary,
      args,
      env: childEnvironment(env, true),
      state,
      smokeDirectory: join(env.RUNNER_TEMP, "qa-proxy-smoke"),
      submission: local(plan.fault.submission),
      expectedTag: plan.fault.tag,
      expectedCommit: env.REVIEWED_COMMIT,
      expectedSha256: plan.fault.sha256,
      expectedSize: plan.fault.size,
    });
  }
  let baseline = initialBaseline;
  for (const attempt of ["publish", "same-state-replay"]) {
    cli(args, 900000, true);
    const catalog = JSON.parse(file(join(state, "catalog-publication-receipt.json")));
    const discovery = JSON.parse(file(join(state, "discovery-receipt.json")));
    assert.equal(catalog.status, "published_verified");
    assert.equal(discovery.status, "discovery_verified");
    assert.equal(discovery.branch, "marketplace-v2");
    assert.equal(catalog.repository, REPOSITORY);
    assert.equal(catalog.registry_commit, env.REVIEWED_COMMIT);
    assert.equal(catalog.tag_commit, env.REVIEWED_COMMIT);
    const publicBytes = await bytes(catalog.catalog_url); // Deliberately anonymous.
    assert.equal(publicBytes.length, catalog.catalog_size);
    assert.equal(sha(publicBytes), catalog.catalog_sha256);
    const index = join(root, `${attempt}-index.json`);
    writeFileSync(index, publicBytes, { flag: "wx" });
    verify(index);
    continuity(JSON.parse(file(plan.previous)), JSON.parse(publicBytes), plan);
    archiveCoverage(JSON.parse(publicBytes), plan.archives);
    for (const archive of plan.archives) {
      assert.ok(archive.url.startsWith(`https://github.com/${REPOSITORY}/releases/download/`));
      const anonymous = await bytes(archive.url);
      assert.equal(anonymous.length, archive.size);
      assert.equal(sha(anonymous), archive.sha256);
    }
    const mirrors =
      plan.phase === "renewal"
        ? []
        : readdirSync(join(state, "publications")).map((dir) =>
            JSON.parse(file(join(state, "publications", dir, "mirror-receipt.json"))),
          );
    assert.equal(mirrors.length, plan.phase === "renewal" ? 0 : 3);
    assert.deepEqual(mirrors.map((m) => m.release_tag).sort(), [...plan.mirror_tags].sort());
    if (env.QA_RUNNER === "fresh")
      for (const mirror of mirrors) assert.equal(mirror.status, "published_recovered");
    const after = await waitForObservation(
      async (signal) => {
        const observed = await readInventory(signal);
        preserved(before.releases, observed.releases); // Drift is fatal, not a retryable stale observation.
        replayUnchanged(observed, baseline);
        return observed;
      },
      (observed) =>
        expectedDiscovery(observed, discovery, catalog.catalog_sha256) &&
        observed.releases.some((r) => r.id === catalog.release_id && !r.draft) &&
        plan.mirror_tags.every((tag) => observed.releases.some((r) => r.tag === tag && !r.draft)),
    );
    const anonymousDiscovery = await bytes(
      `https://raw.githubusercontent.com/${REPOSITORY}/${after.head}/managed-index.json`,
    );
    assert.equal(sha(anonymousDiscovery), catalog.catalog_sha256);
    replayUnchanged(after, baseline);
    if (interrupted) {
      const recovered = after.releases.find((r) => r.id === interrupted.releaseId);
      assert.ok(recovered);
      for (const asset of interrupted.assets)
        assert.ok(
          recovered.assets.some(
            (a) => a.id === asset.id && a.size === asset.size && a.name === asset.name,
          ),
        );
    }
    baseline = after;
    // Strict proof allowlist: no environment, private state, raw CLI output or unknown receipt fields.
    writeFileSync(
      join(root, `${attempt}.json`),
      JSON.stringify({
        repository: REPOSITORY,
        request_sha256: env.REQUEST_SHA256,
        plan_sha256: env.PLAN_SHA256,
        commit: env.REVIEWED_COMMIT,
        cli_sha256: BINARY_SHA,
        cli_version: VERSION,
        attempt,
        runner: env.QA_RUNNER,
        catalog_sha256: catalog.catalog_sha256,
        mirror_tags: mirrors.map((m) => m.release_tag),
        interruption_observed: Boolean(interrupted),
        inventory: after,
      }) + "\n",
      { flag: "wx" },
    );
  }
  if (env.QA_RUNNER === "first")
    appendFileSync(env.GITHUB_OUTPUT, `inventory_sha256=${inventoryHash(baseline)}\n`);
} finally {
  unlinkSync(key); // Only this invocation's exclusively-created signing key; never a database.
}
