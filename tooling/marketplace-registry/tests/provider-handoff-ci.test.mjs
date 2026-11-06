import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "registry-handoff-ci-")));
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  const cliRoot = join(root, "released");
  mkdirSync(cliRoot);
  const cli = join(cliRoot, "cadencr");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.TRACE, JSON.stringify(process.argv.slice(2))+"\\n");
if (process.argv.includes("--help")) console.log(process.env.HANDOFF_SUPPORT === "yes" ? "--administrative" : "legacy CLI");
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(root, "scripts/ci/fetch-released-cli.sh"),
    '#!/bin/sh\nprintf "%s\\n" "$CLI_ROOT/cadencr"\n',
  );
  // This is a Linux CI orchestration test. Stub its GNU date dependency so
  // argument routing can also be exercised on macOS without changing production.
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/date"), '#!/bin/sh\nprintf "2026-11-06T00:00:00Z\\n"\n', {
    mode: 0o700,
  });
  for (const name of ["select-publisher-runtime.sh", "validate-provider-contribution.sh"]) {
    copyFileSync(new URL(`../scripts/ci/${name}`, import.meta.url), join(root, "scripts/ci", name));
  }
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    CLI_ROOT: cliRoot,
    TRACE: join(root, "trace"),
    GITHUB_OUTPUT: join(root, "output"),
    RUNNER_TEMP: root,
  };
  return {
    root,
    env,
    trace: () => readFileSync(env.TRACE, "utf8").trim().split("\n").map(JSON.parse),
  };
}

test("normal CI never selects administrative mode or candidate-owned handoffs", () => {
  for (const mode of ["validate", "tooling", "administrative"]) {
    const f = fixture();
    const base = join(f.root, "base");
    const candidate = join(f.root, "candidate");
    for (const root of [base, candidate]) {
      mkdirSync(join(root, "packages"), { recursive: true });
      writeFileSync(join(root, "provider-handoffs.json"), "[]");
    }
    writeFileSync(join(candidate, "packages/example.json"), "{}");
    const result = spawnSync(
      "sh",
      ["scripts/ci/validate-provider-contribution.sh", "pin.env", base, candidate, mode],
      { cwd: f.root, env: f.env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = f.trace();
    assert.equal(calls[0].includes("--administrative"), mode === "administrative");
    if (mode === "tooling")
      assert.equal(
        calls[1][calls[1].indexOf("--provider-handoffs") + 1],
        join(base, "provider-handoffs.json"),
      );
  }
});

test("publisher selection checks capability without depending on an operator request", () => {
  for (const scenario of ["legacy", "qualified"]) {
    const f = fixture();
    writeFileSync(join(f.root, "provider-handoffs.json"), '[{"provider_id":"pi"}]');
    f.env.HANDOFF_SUPPORT = scenario === "legacy" ? "no" : "yes";
    const result = spawnSync("sh", ["scripts/ci/select-publisher-runtime.sh"], {
      cwd: f.root,
      env: f.env,
      encoding: "utf8",
    });
    assert.equal(result.status === 0, scenario === "qualified", result.stderr);
    if (scenario === "legacy")
      assert.match(result.stderr, /lacks qualified provider handoff support/);
  }
});

test("catalog-only automation can activate only the isolated administrative channel", () => {
  for (const channel of ["marketplace-v2", "marketplace-v2-admin", "other"]) {
    const f = fixture();
    copyFileSync(
      new URL("../scripts/ci/registry-feeds.sh", import.meta.url),
      join(f.root, "scripts/ci/registry-feeds.sh"),
    );
    const env = {
      ...f.env,
      GITHUB_REPOSITORY: "owner/registry",
      CADENCR_REGISTRY_CATALOG_URL: `https://raw.githubusercontent.com/owner/registry/refs/heads/${channel}/managed-index.json`,
      CADENCR_REGISTRY_KEY_ID: "test-key",
      CADENCR_REGISTRY_PUBLIC_KEY_PEM: "public fixture",
    };
    const result = spawnSync("sh", ["scripts/ci/registry-feeds.sh", "gate", "renewal", "catalog"], {
      cwd: f.root,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status === 0, channel === "marketplace-v2-admin", result.stderr);
  }
});

test("protected publication binds baseline history plus only the new delta", () => {
  for (const scenario of [
    "first",
    "renewal",
    "second",
    "mismatch",
    "reordered",
    "legacy",
    "legacy-delta",
  ]) {
    const f = fixture();
    copyFileSync(
      new URL("../scripts/ci/confirm-provider-handoffs.cjs", import.meta.url),
      join(f.root, "scripts/ci/confirm-provider-handoffs.cjs"),
    );
    const pi = { provider_id: "pi", reason: "reviewed" };
    const other = { provider_id: "other", reason: "reviewed separately" };
    const previous = ["first", "legacy", "legacy-delta"].includes(scenario) ? [] : [pi];
    const delta = ["renewal", "legacy"].includes(scenario)
      ? []
      : [scenario === "first" ? pi : other];
    let reviewed = scenario === "legacy" ? [pi] : [...previous, ...delta];
    if (scenario === "mismatch") reviewed = [pi];
    if (scenario === "reordered")
      reviewed = reviewed.map(({ reason, provider_id }) => ({ reason, provider_id }));
    writeFileSync(join(f.root, "provider-handoffs.json"), JSON.stringify(reviewed));
    writeFileSync(
      join(f.root, "baseline.json"),
      JSON.stringify({ signed: { provider_handoffs: previous } }),
    );
    const request = {
      previous_index: "baseline.json",
      provider_handoffs: delta,
      discovery_branch: scenario.startsWith("legacy") ? "marketplace-v2" : "marketplace-v2-admin",
    };
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        'require("./scripts/ci/confirm-provider-handoffs.cjs").confirmHandoffs(JSON.parse(process.env.REQUEST))',
      ],
      {
        cwd: f.root,
        env: { ...f.env, REQUEST: JSON.stringify(request) },
        encoding: "utf8",
      },
    );
    assert.equal(
      result.status === 0,
      !["mismatch", "legacy-delta"].includes(scenario),
      result.stderr,
    );
  }
});
