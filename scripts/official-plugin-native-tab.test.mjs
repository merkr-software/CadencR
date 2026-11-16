import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { nativeTabFixture } from "./official-plugin-fixtures.mjs";
const hash = (data) => createHash("sha256").update(data).digest("hex");

for (const real of [false, true]) {
  test(
    `native tab: complete deterministic UI and platform bindings (${real ? "Rust CLI" : "orchestration"})`,
    { skip: real && !process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI },
    () => {
      const f = nativeTabFixture(
        real ? realpathSync(process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI) : undefined,
      );
      const a = f.run();
      const b = f.run();
      assert.equal(a.status, 0, a.stderr);
      assert.equal(b.status, 0, b.stderr);
      const release = JSON.parse(readFileSync(join(a.output, "release.json")));
      const metadata = JSON.parse(readFileSync(join(a.output, "package.json")));
      assert.equal(release.archives[0].target, "tab", "author release primary artifact is the UI");
      if (real) {
        const asset = (name) => {
          const bytes = readFileSync(join(a.output, name));
          return { name, size: bytes.length, sha256: hash(bytes) };
        };
        const request = {
          schema_version: 1,
          repository: "merkr-software/CadencR",
          expected_repository_id: 123,
          expected_account: "fixture",
          tag: `plugins/${f.plugin}/v1.0.0`,
          source_commit: "a".repeat(40),
          release_notes: "Inert native tab",
          prerelease: false,
          archive: asset(release.archives[0].name),
          metadata: asset("package.json"),
          additional_archives: release.archives.slice(1).map((archive) => asset(archive.name)),
        };
        const path = join(f.root, "author-request.json");
        writeFileSync(path, JSON.stringify(request));
        const inspected = spawnSync(
          realpathSync(process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI),
          ["plugin", "inspect-release", "--request", path, "--directory", a.output],
          { encoding: "utf8", timeout: 30_000 },
        );
        assert.equal(inspected.status, 0, inspected.stderr);
      }
      assert.deepEqual(
        release.archives.map((archive) => archive.target).sort(),
        ["tab", ...Object.keys(f.binaries).map((platform) => `backend-${platform}`)].sort(),
      );
      for (const archive of release.archives) {
        const data = readFileSync(join(a.output, archive.name));
        assert.equal(hash(data), archive.sha256);
        assert.equal(data.length, archive.size);
        assert.deepEqual(data, readFileSync(join(b.output, archive.name)));
        if (real) {
          const tar = gunzipSync(data);
          if (archive.target === "tab") {
            for (const bytes of Object.values(f.binaries))
              assert.equal(tar.includes(bytes), false, "no executable payload in UI archive");
          } else {
            const command = `bin/${archive.target.slice("backend-".length)}/backend`;
            assert.equal(tar.subarray(0, 100).toString().split(String.fromCharCode(0))[0], command);
            assert.equal(parseInt(tar.subarray(100, 108).toString(), 8), 0o755);
          }
        }
        if (archive.target === "tab") continue;
        const platform = archive.target.slice("backend-".length);
        const signed = metadata.package.tab.distribution.binary[platform];
        assert.equal(signed.sha256, archive.sha256);
        assert.equal(signed.size, archive.size);
        assert.equal(signed.executable_sha256, hash(f.binaries[platform]));
        assert.equal(signed.executable_size, f.binaries[platform].length);
        assert.equal(signed.cmd, `bin/${platform}/backend`);
        assert.ok(signed.archive.endsWith(`/${archive.name}`));
      }
      assert.deepEqual(
        readFileSync(join(a.output, "package.json")),
        readFileSync(join(b.output, "package.json")),
      );
      if (!real) {
        const calls = readFileSync(join(f.root, "calls"), "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        for (const call of calls.filter((args) => args[0] === "plugin"))
          assert.ok(call.includes("--no-run"));
        assert.equal(calls.filter((args) => args[1] === "pack-tab-backend").length, 12);
      }
    },
  );
}

test("native tab: incomplete/extra targets and differing manifests fail without public output", () => {
  for (const change of ["missing", "missing-ui", "extra", "manifest", "digest", "mode"]) {
    const f = nativeTabFixture();
    const backend = f.entry.payloads[`backend-${f.target}`];
    if (change === "missing-ui") delete f.entry.payloads.tab;
    if (change === "missing") delete f.entry.payloads[`backend-${f.target}`];
    if (change === "extra") f.entry.payloads["backend-windows-x86_64"] = backend;
    if (change === "manifest") {
      const path = `${backend.directory}/tab.json`;
      f.files[path] += " ";
      backend.files["tab.json"].sha256 = hash(f.files[path]);
    }
    if (change === "digest") backend.files[f.cmd].sha256 = "f".repeat(64);
    if (change === "mode") f.modes[`${backend.directory}/${f.cmd}`] = "100644";
    f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
    f.save();
    const result = f.run();
    assert.notEqual(result.status, 0, change);
    assert.equal(existsSync(result.output), false, change);
    if (change === "missing-ui") assert.match(result.stderr, /package targets differ/);
  }
});

test(
  "native tab: Rust refuses scripts and metadata/manifest binding drift before output",
  { skip: !process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI },
  () => {
    for (const change of ["script", "reasoning", "cmd", "platform"]) {
      const f = nativeTabFixture(realpathSync(process.env.CADENCR_OFFICIAL_PLUGIN_TEST_CLI));
      const metadata = JSON.parse(f.files[f.entry.package]);
      if (change === "script") {
        const payload = f.entry.payloads[`backend-${f.target}`];
        const script = "#!/bin/sh\nexit 99\n";
        f.files[`${payload.directory}/${f.cmd}`] = script;
        payload.files[f.cmd].sha256 = hash(script);
      }
      if (change === "reasoning") metadata.package.tab.backend.reasoning = "Different reason.";
      if (change === "cmd") metadata.package.tab.distribution.binary[f.target].cmd = "bin/wrong";
      if (change === "platform") {
        delete metadata.package.tab.distribution.binary[f.target];
        delete f.entry.payloads[`backend-${f.target}`];
      }
      f.files[f.entry.package] = JSON.stringify(metadata);
      f.files["plugins/release-policy.json"] = JSON.stringify(f.policy);
      f.save();
      const result = f.run();
      assert.notEqual(result.status, 0, change);
      assert.equal(existsSync(result.output), false, change);
    }
  },
);

test("native tab: every executable receipt binding is exact before output", () => {
  for (const field of ["target", "cmd", "executable_sha256", "executable_size"]) {
    const f = nativeTabFixture();
    writeFileSync(join(f.root, "backend-receipt-field"), field);
    const result = f.run();
    assert.notEqual(result.status, 0, field);
    assert.match(result.stderr, /receipt mismatch/);
    assert.equal(existsSync(result.output), false);
  }
});
