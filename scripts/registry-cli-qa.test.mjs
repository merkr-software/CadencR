import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import {
  bytes,
  inventory,
  archiveCoverage,
  initialObservation,
  replayUnchanged,
  preserved,
  continuity,
  childEnvironment,
  expectedDiscovery,
  inventoryHash,
  failureDiagnostic,
} from "./registry-cli-qa/evidence.mjs";
import { guard, local } from "./registry-cli-qa/guard.mjs";
test("guard rejects wrong repository before opening reviewed files", () => {
  assert.throws(() => guard({ GITHUB_REPOSITORY: "other/repo" }));
  assert.throws(() => local("../private.pem"));
  assert.throws(() => local("/tmp/private.pem"));
});
test("inventory preservation includes timestamps, IDs and digest", () => {
  const before = [{ id: 1, updated_at: "a", assets: [{ id: 2, digest: "sha256:a", size: 1 }] }];
  preserved(before, structuredClone(before));
  for (const change of [
    (a) => (a[0].updated_at = "b"),
    (a) => (a[0].assets[0].digest = "b"),
    (a) => (a[0].assets[0].id = 3),
  ]) {
    const after = structuredClone(before);
    change(after);
    assert.throws(() => preserved(before, after));
  }
});
test("renewal requires package continuity and advancing expiry", () => {
  const previous = {
    signed: { packages: [{ kind: "theme" }], generated_at: "2026-01-01", expires_at: "2026-01-02" },
  };
  const current = structuredClone(previous);
  assert.throws(() => continuity(previous, current, { phase: "renewal" }));
  current.signed.generated_at = "2026-01-02";
  current.signed.expires_at = "2026-01-03";
  continuity(previous, current, { phase: "renewal" });
  current.signed.packages = [];
  assert.throws(() => continuity(previous, current, { phase: "renewal" }));
});
test("anonymous HTTP observations enforce size and deadline", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/slow") return;
    res.end(Buffer.alloc(16777217));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(bytes(url));
    await assert.rejects(bytes(url + "/slow", {}, AbortSignal.timeout(20)));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("synthetic child deadline is terminal", () => {
  const result = spawnSync(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeout: 30,
    killSignal: "SIGKILL",
  });
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGKILL");
});

test("child environments expose credentials only to authenticated pipeline", () => {
  const env = {
    HOME: "/home/qa",
    PATH: "/bin",
    QA_SIGNING_KEY_PEM: "secret",
    CADENCR_REGISTRY_GITHUB_TOKEN: "token",
    GITHUB_TOKEN: "other",
    HTTPS_PROXY: "proxy",
    NODE_OPTIONS: "--require=bad",
  };
  assert.deepEqual(childEnvironment(env), { HOME: "/home/qa", PATH: "/bin" });
  assert.deepEqual(childEnvironment(env, true), {
    HOME: "/home/qa",
    PATH: "/bin",
    CADENCR_REGISTRY_GITHUB_TOKEN: "token",
  });
});
test("discovery receipt must match authenticated blob and snapshot; head affects replay digest", () => {
  const blob = "a".repeat(40),
    digest = "b".repeat(64);
  const observation = { head: "c".repeat(40), blob, discovery_sha256: digest, releases: [] };
  const receipt = { blob_sha: blob, snapshot_sha256: digest };
  assert.equal(expectedDiscovery(observation, receipt, digest), true);
  assert.equal(expectedDiscovery({ ...observation, blob: "d".repeat(40) }, receipt, digest), false);
  assert.equal(
    expectedDiscovery({ ...observation, discovery_sha256: "e".repeat(64) }, receipt, digest),
    false,
  );
  assert.throws(() =>
    expectedDiscovery(observation, { ...receipt, snapshot_sha256: "f".repeat(64) }, digest),
  );
  assert.notEqual(
    inventoryHash(observation),
    inventoryHash({ ...observation, head: "d".repeat(40) }),
  );
});

test("first observation rejects stale feed; fresh first attempt must preserve exact inventory", () => {
  const before = { discovery_sha256: "a", head: "b", releases: [] };
  assert.equal(initialObservation(before, "first", "a"), undefined);
  assert.throws(() => initialObservation(before, "first", "stale"));
  const baseline = initialObservation(before, "fresh", "stale", inventoryHash(before));
  replayUnchanged(structuredClone(before), baseline);
  assert.throws(() => replayUnchanged({ ...before, head: "changed" }, baseline));
  assert.throws(() => replayUnchanged({ ...before, releases: [{ id: 9 }] }, baseline));
  assert.throws(() => initialObservation(before, "fresh", "stale", "wrong"));
});

test("archive coverage rejects omissions, extras, duplicates and wrong digests across kinds", () => {
  const distribution = (name) => ({
    archive: `https://github.com/merkr-software/cadencr-registry-qa/releases/download/v1/${name}`,
    sha256: name,
  });
  const values = ["linux", "darwin", "theme", "tab"].map(distribution);
  const catalog = {
    signed: {
      packages: [
        { agent: { distribution: { binary: { linux: values[0], darwin: values[1] } } } },
        { kind: "theme", package: { theme: { distribution: values[2] } } },
        { kind: "tab", package: { tab: { distribution: values[3] } } },
      ],
    },
  };
  const archives = values.map((v) => ({ url: v.archive, sha256: v.sha256, size: 10 }));
  archiveCoverage(catalog, archives);
  for (const bad of [
    [],
    archives.slice(1),
    [...archives, { ...archives[0] }],
    [...archives, { url: distribution("extra").archive, sha256: "extra", size: 10 }],
    archives.map((a, i) => (i ? a : { ...a, sha256: "wrong" })),
  ]) {
    assert.throws(() => archiveCoverage(catalog, bad));
  }
});

test("native tab archive coverage includes UI and every backend without changing UI-only tabs", () => {
  const distribution = (name) => ({
    archive: `https://github.com/merkr-software/cadencr-registry-qa/releases/download/v1/${name}`,
    sha256: name,
  });
  const values = ["ui", "linux", "darwin", "windows"].map(distribution);
  const tab = {
    ...values[0],
    binary: {
      "linux-x86_64": values[1],
      "darwin-aarch64": values[2],
      "windows-x86_64": values[3],
    },
  };
  const catalog = {
    signed: { packages: [{ kind: "tab", package: { tab: { distribution: tab } } }] },
  };
  const archives = values.map((value) => ({ url: value.archive, sha256: value.sha256, size: 10 }));
  archiveCoverage(catalog, archives);
  for (let index = 0; index < archives.length; index++) {
    assert.throws(() =>
      archiveCoverage(
        catalog,
        archives.filter((_, i) => i !== index),
      ),
    );
    assert.throws(() => archiveCoverage(catalog, [...archives, { ...archives[index] }]));
    const tampered = archives.map((value, i) =>
      i === index ? { ...value, sha256: "wrong" } : value,
    );
    assert.throws(() => archiveCoverage(catalog, tampered));
  }
  const extra = { url: distribution("extra").archive, sha256: "extra", size: 10 };
  assert.throws(() => archiveCoverage(catalog, [...archives, extra]));
  delete tab.binary;
  archiveCoverage(catalog, archives.slice(0, 1));
  assert.throws(() => archiveCoverage(catalog, archives));
});

async function mockedInventory(t, { assetCount = 0, pages = 1, abort = false } = {}) {
  let active = 0,
    maximum = 0;
  const paths = [];
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.signal, controller.signal);
    const path = new URL(url).pathname + new URL(url).search;
    paths.push(path);
    let value;
    if (path.endsWith("/cadencr-registry-qa")) value = { id: 1420296872, private: false };
    else if (path.includes("/releases?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      value = Array.from({ length: page < pages ? 100 : 7 }, (_, i) => ({
        id: page * 100 + 6 - i,
        tag_name: `v${page}-${i}`,
        draft: false,
      }));
    } else if (path.includes("/assets?")) {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(controller.signal.reason);
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          }, 5);
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (abort && active === 4) controller.abort(new Error("shared deadline"));
        });
      } finally {
        active--;
      }
      value = Array.from({ length: assetCount }, (_, id) => ({ id }));
    } else if (path.includes("/git/ref/")) value = { object: { sha: "a".repeat(40) } };
    else
      value = {
        encoding: "base64",
        content: Buffer.from("catalog").toString("base64"),
        sha: "b".repeat(40),
      };
    return new Response(JSON.stringify(value));
  });
  if (abort || assetCount === 100) {
    await assert.rejects(inventory("token", controller.signal));
    assert.ok(!paths.some((p) => p.includes("/git/ref/")));
  } else {
    const result = await inventory("token", controller.signal);
    assert.equal(result.releases.length, pages === 1 ? 7 : 107);
    assert.deepEqual(
      result.releases.map((r) => r.id),
      result.releases.map((r) => r.id).sort((a, b) => a - b),
    );
  }
  assert.ok(maximum > 1 && maximum <= 4);
}

test("inventory overlaps at most four asset reads and paginates deterministically", async (t) => {
  await mockedInventory(t, { pages: 2 });
});
test("inventory rejects unsupported asset pagination", async (t) => {
  await mockedInventory(t, { assetCount: 100 });
});
test("inventory shares abort deadline across concurrent asset reads", async (t) => {
  await mockedInventory(t, { abort: true });
});

test("CLI failure diagnostics retain only bounded codes and message hashes", () => {
  const secret = "private-key-or-token-do-not-retain";
  const result = {
    status: 1,
    signal: null,
    stderr: JSON.stringify({ ok: false, code: "REGISTRY_PIPELINE_FAILED", message: secret }),
    stdout: secret,
  };
  const safe = failureDiagnostic(result);
  assert.equal(safe.cli_code, "REGISTRY_PIPELINE_FAILED");
  assert.match(safe.message_sha256, /^[a-f0-9]{64}$/);
  assert.equal(safe.exit_status, 1);
  assert.ok(!JSON.stringify(safe).includes(secret));
  for (const stderr of [
    secret,
    "null",
    "{}",
    "x".repeat(16385),
    JSON.stringify({ ok: false, code: secret, message: "x".repeat(8193) }),
  ]) {
    const diagnostic = failureDiagnostic({ ...result, stderr });
    assert.equal(diagnostic.cli_code, null);
    assert.equal(diagnostic.message_sha256, null);
    assert.ok(!JSON.stringify(diagnostic).includes(secret));
  }
  assert.equal(
    failureDiagnostic({ status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" } })
      .process_error,
    "ETIMEDOUT",
  );
});

test("read-only transport retries recover fetch and body failures under the same signal", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    assert.equal(options.signal, controller.signal);
    assert.deepEqual(options.headers, { Accept: "fixture" });
    if (calls === 1) throw new TypeError("fetch failed");
    if (calls === 2)
      return {
        status: 200,
        body: (async function* () {
          yield Buffer.from("discard-partial-body");
          throw new TypeError("terminated");
        })(),
      };
    return new Response("complete");
  });
  assert.equal(
    (await bytes("https://fixture.invalid", { Accept: "fixture" }, controller.signal)).toString(),
    "complete",
  );
  assert.equal(calls, 3);
});

test("read-only transport retries stop at three attempts", async (t) => {
  let calls = 0;
  const failure = new TypeError("fetch failed");
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw failure;
  });
  await assert.rejects(bytes("https://fixture.invalid"), (error) => error === failure);
  assert.equal(calls, 3);
});

test("caller abort interrupts transport retry backoff without another read", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    setTimeout(() => controller.abort(new Error("caller deadline")), 10);
    throw new TypeError("fetch failed");
  });
  await assert.rejects(bytes("https://fixture.invalid", {}, controller.signal), {
    name: "AbortError",
  });
  assert.equal(calls, 1);
  await assert.rejects(bytes("https://fixture.invalid", {}, controller.signal), /caller deadline/);
  assert.equal(calls, 1);
});

test("HTTP, oversize, abort and non-transport errors never retry", async (t) => {
  for (const respond of [
    () => new Response("unavailable", { status: 503 }),
    () => new Response(Buffer.alloc(16777217)),
    () => {
      throw new TypeError("other error");
    },
    () => {
      throw new Error("fetch failed");
    },
    () => {
      throw new DOMException("aborted", "AbortError");
    },
  ]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return respond();
    });
    await assert.rejects(bytes("https://fixture.invalid"));
    assert.equal(calls, 1);
    mock.mock.restore();
  }
});

test("JSON parsing and integrity checks remain outside read-only retry boundary", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("not JSON or expected bytes");
  });
  await assert.rejects(async () => JSON.parse(await bytes("https://fixture.invalid")));
  assert.equal(calls, 1);
  await assert.rejects(async () =>
    assert.equal((await bytes("https://fixture.invalid")).length, 1),
  );
  assert.equal(calls, 2);
});
