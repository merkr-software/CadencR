import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { REPOSITORY, sha } from "./guard.mjs";
export async function bytes(url, headers = {}, signal = AbortSignal.timeout(60000)) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { headers, signal, redirect: "follow" });
      assert.equal(response.status, 200);
      const parts = [];
      let size = 0;
      for await (const part of response.body) {
        signal.throwIfAborted();
        size += part.length;
        assert.ok(size <= 16777216, "response exceeds 16 MiB");
        parts.push(part);
      }
      signal.throwIfAborted();
      return Buffer.concat(parts);
    } catch (error) {
      signal.throwIfAborted();
      // Read-only transport recovery only; integrity/status/JSON failures stay terminal.
      const transportFailure =
        error instanceof TypeError && ["fetch failed", "terminated"].includes(error.message);
      if (!transportFailure || attempt === 3) throw error;
      await delay(250, undefined, { signal }); // One caller deadline, never reset per attempt.
    }
  }
}
export async function inventory(token, signal = AbortSignal.timeout(60000)) {
  const get = async (path) =>
    JSON.parse(
      await bytes(
        `https://api.github.com/repos/${REPOSITORY}${path}`,
        { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        signal,
      ),
    );
  const repository = await get("");
  assert.equal(repository.id, 1420296872);
  assert.equal(repository.private, false);
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await get(`/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(batch));
    const observed = await boundedMap(
      batch,
      async (release) => {
        const assets = await get(`/releases/${release.id}/assets?per_page=100`);
        assert.ok(
          Array.isArray(assets) && assets.length < 100,
          "asset pagination not supported; fail closed",
        );
        return {
          id: release.id,
          tag: release.tag_name,
          draft: release.draft,
          updated_at: release.updated_at,
          assets: assets
            .map((a) => ({
              id: a.id,
              name: a.name,
              size: a.size,
              digest: a.digest,
              updated_at: a.updated_at,
            }))
            .sort((a, b) => a.id - b.id),
        };
      },
      signal,
    );
    releases.push(...observed);
    if (batch.length < 100) {
      const head = (await get("/git/ref/heads/marketplace-v2")).object.sha;
      assert.match(head, /^[a-f0-9]{40}$/);
      const content = await get(`/contents/managed-index.json?ref=${head}`);
      assert.equal(content.encoding, "base64");
      const decoded = Buffer.from(content.content, "base64");
      return {
        head,
        blob: content.sha,
        discovery_sha256: sha(decoded),
        releases: releases.sort((a, b) => a.id - b.id),
      };
    }
  }
  throw new Error("release inventory exceeds bound");
}
export function preserved(before, after) {
  for (const release of before)
    assert.deepEqual(
      after.find((r) => r.id === release.id),
      release,
    );
}
export function continuity(previous, current, plan) {
  const before = previous.signed.packages,
    after = current.signed.packages;
  for (const entry of before)
    assert.ok(after.some((candidate) => isDeepStrictEqual(entry, candidate)));
  const added = after.filter(
    (entry) => !before.some((candidate) => isDeepStrictEqual(entry, candidate)),
  );
  if (plan.phase === "renewal") {
    assert.deepEqual(after, before);
    assert.ok(Date.parse(current.signed.expires_at) > Date.parse(previous.signed.expires_at));
    assert.ok(Date.parse(current.signed.generated_at) > Date.parse(previous.signed.generated_at));
  } else {
    assert.equal(added.length, 3);
    // Exact CLI-generated entry hashes bind all three reviewed fixtures, including unwrapped providers.
    assert.deepEqual(
      added.map((e) => sha(Buffer.from(JSON.stringify(e)))).sort(),
      [...plan.added_entry_sha256].sort(),
    );
  }
}

export const inventoryHash = (observation) => sha(Buffer.from(JSON.stringify(observation)));
export function childEnvironment(env, authenticated = false) {
  const clean = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    if (env[key] !== undefined) clean[key] = env[key];
  }
  if (authenticated) clean.CADENCR_REGISTRY_GITHUB_TOKEN = env.CADENCR_REGISTRY_GITHUB_TOKEN;
  return clean;
}
export function expectedDiscovery(observation, receipt, catalogSha) {
  assert.match(receipt.blob_sha, /^[a-f0-9]{40}$/);
  assert.equal(receipt.snapshot_sha256, catalogSha);
  return observation.blob === receipt.blob_sha && observation.discovery_sha256 === catalogSha;
}

// Four workers share the inventory's single deadline; no per-release deadline reset.
async function boundedMap(items, operation, signal) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          signal.throwIfAborted();
          results[index] = await operation(items[index]);
          signal.throwIfAborted();
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}

export function initialObservation(observation, runner, previousSha, expectedInventorySha) {
  if (runner === "first") {
    assert.equal(
      observation.discovery_sha256,
      previousSha,
      "live discovery differs from reviewed previous catalog",
    );
    return undefined;
  }
  assert.equal(runner, "fresh");
  assert.equal(inventoryHash(observation), expectedInventorySha);
  return observation;
}

export function replayUnchanged(observation, baseline) {
  if (baseline) assert.deepEqual(observation, baseline, "replay changed discovery or releases");
}

export function archiveCoverage(catalog, archives) {
  const expected = new Map();
  for (const entry of catalog.signed.packages) {
    const body = entry.kind ? entry.package : entry;
    const descriptor = body.agent ?? body.theme ?? body.tab;
    const distribution = descriptor.distribution;
    const binaries = Object.values(distribution.binary ?? {});
    const values = body.agent ? binaries : body.tab ? [distribution, ...binaries] : [distribution];
    for (const value of values) {
      const prior = expected.get(value.archive);
      assert.ok(prior === undefined || prior === value.sha256, "conflicting archive digests");
      expected.set(value.archive, value.sha256);
    }
  }
  const actual = new Map();
  for (const archive of archives) {
    assert.ok(!actual.has(archive.url), "duplicate reviewed archive");
    assert.ok(archive.url.startsWith(`https://github.com/${REPOSITORY}/releases/download/`));
    assert.ok(Number.isSafeInteger(archive.size) && archive.size > 0);
    actual.set(archive.url, archive.sha256);
  }
  assert.deepEqual(actual, expected, "reviewed archives must exactly cover authenticated catalog");
}

// Whole-string allowlist only: never return message fragments or inferred stages.
function failureReason(message) {
  const reasons = new Map([
    ["public discovery: convergence read budget exhausted", "discovery_convergence_exhausted"],
    ["public discovery: read budget exhausted", "discovery_read_exhausted"],
    ["GitHub discovery verification deadline exceeded", "discovery_deadline"],
    ["GitHub API request failed", "github_transport"],
  ]);
  const status = /^GitHub API request failed with status ([1-5][0-9]{2})$/.exec(message);
  // JS $ also matches before a final newline; enforce the complete message.
  if (status && status[0] === message)
    return { reason: "github_status", http_status: Number(status[1]) };
  return { reason: reasons.get(message) ?? null, http_status: null };
}

// Keep failure diagnosis useful without exposing child output, paths, or secrets.
export function failureDiagnostic(result) {
  let code = null,
    messageHash = null;
  let classification = { reason: null, http_status: null };
  if (typeof result.stderr === "string" && Buffer.byteLength(result.stderr) <= 16384) {
    try {
      const value = JSON.parse(result.stderr);
      if (
        value?.ok === false &&
        typeof value.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)
      )
        code = value.code;
      if (
        value?.ok === false &&
        typeof value.message === "string" &&
        Buffer.byteLength(value.message) <= 8192
      ) {
        messageHash = sha(Buffer.from(value.message));
        classification = failureReason(value.message);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Malformed/unstructured child output is deliberately not disclosed.
    }
  }
  return {
    exit_status: Number.isInteger(result.status) ? result.status : null,
    signal: ["SIGTERM", "SIGKILL"].includes(result.signal) ? result.signal : null,
    process_error: ["ETIMEDOUT", "ENOBUFS", "ENOENT"].includes(result.error?.code)
      ? result.error.code
      : null,
    cli_code: code,
    message_sha256: messageHash,
    ...classification,
  };
}
