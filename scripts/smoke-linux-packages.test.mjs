import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), "cadencr-linux-smoke-"));
  t.after(() => rmSync(scratch, { recursive: true }));
  const dist = join(scratch, "packages with spaces");
  const bin = join(scratch, "bin");
  mkdirSync(dist);
  mkdirSync(bin);
  const appimage = "Cadencr-0.16.0-x86_64.AppImage";
  writeFileSync(
    join(dist, appimage),
    [
      "#!/bin/bash",
      'test "$1" = --appimage-extract || exit 90',
      "mkdir -p squashfs-root/resources",
      "cat > squashfs-root/resources/cadencr-service <<'SH'",
      "#!/bin/bash",
      'test "$1" = --help || exit 91',
      'exit "${SMOKE_SIDECAR_STATUS:-0}"',
      "SH",
      "chmod +x squashfs-root/resources/cadencr-service",
    ].join("\n"),
    { mode: 0o644 },
  );
  const deb = "Cadencr-0.16.0-amd64.deb";
  const rpm = "Cadencr-0.16.0-x86_64.rpm";
  for (const name of [deb, rpm]) writeFileSync(join(dist, name), name);
  writeFileSync(
    join(dist, "latest-linux.yml"),
    [appimage, deb, rpm].map((name) => `- url: ${name}`).join("\n"),
  );
  // Model the Docker boundary: package mounts must be read-only; extraction
  // runs in a disposable container filesystem. Distro installs are stubbed.
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      'const { join } = require("node:path");',
      "const args = process.argv.slice(2);",
      'fs.appendFileSync(process.env.SMOKE_CALLS, JSON.stringify(args) + "\\n");',
      'const [source, target, mode] = args[args.indexOf("-v") + 1].split(":");',
      'if (target !== "/pkg" || mode !== "ro") {',
      '  console.error("Refusing a container write into the host filesystem");',
      "  process.exit(92);",
      "}",
      "const script = args.at(-1);",
      'if (script.includes("--appimage-extract")) {',
      '  const work = fs.mkdtempSync(join(process.env.SMOKE_PRIVATE_TMP, "container-"));',
      '  const result = spawnSync("bash", ["-eu", "-c", script.replaceAll("/pkg/", source + "/")], { cwd: work, stdio: "inherit" });',
      "  fs.rmSync(work, { recursive: true });",
      "  process.exit(result.status ?? 93);",
      "}",
      'if (!script.includes("apt-get install") && !script.includes("dnf install") && !script.includes("zypper")) process.exit(94);',
    ].join("\n"),
    { mode: 0o700 },
  );
  const script = join(scratch, "standalone-smoke.sh");
  copyFileSync(new URL("./smoke-linux-packages.sh", import.meta.url), script);
  return { scratch, dist, bin, script };
}

function snapshot(dist) {
  return readdirSync(dist).map((name) => ({
    name,
    bytes: readFileSync(join(dist, name)),
    mode: statSync(join(dist, name)).mode,
  }));
}

function runSmoke(input, sidecarStatus = 0) {
  const calls = join(input.scratch, "calls.jsonl");
  writeFileSync(calls, "");
  const { BASH_ENV: _ignored, ...inherited } = process.env;
  const result = spawnSync("bash", [input.script, input.dist, "0.16.0", "x64"], {
    env: {
      ...inherited,
      PATH: `${input.bin}:${process.env.PATH}`,
      SMOKE_CALLS: calls,
      SMOKE_PRIVATE_TMP: input.scratch,
      SMOKE_SIDECAR_STATUS: String(sidecarStatus),
    },
    encoding: "utf8",
  });
  const lines = readFileSync(calls, "utf8").trim();
  return { result, calls: lines ? lines.split("\n").map(JSON.parse) : [] };
}

test("standalone Linux smoke checks extract the AppImage without writable host mounts", (t) => {
  const input = fixture(t);
  const before = snapshot(input.dist);
  const { result, calls } = runSmoke(input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(calls.length, 7, "all AppImage and distro checks run");
  assert.equal(result.stdout.match(/^PASS /gm).length, 7);
  assert.match(result.stdout, /Linux packages passed smoke tests/);
  assert.deepEqual(snapshot(input.dist), before, "original package bytes and modes stay intact");
  assert.ok(!readdirSync(input.scratch).some((name) => name.startsWith("container-")));
});

test("an AppImage sidecar failure still fails the run and reports all other targets", (t) => {
  const input = fixture(t);
  const before = snapshot(input.dist);
  const { result, calls } = runSmoke(input, 11);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(calls.length, 7);
  assert.equal(result.stdout.match(/^PASS /gm).length, 6);
  assert.match(result.stderr, /FAILED: AppImage payload/);
  assert.doesNotMatch(result.stdout, /Linux packages passed smoke tests/);
  assert.deepEqual(snapshot(input.dist), before);
});
