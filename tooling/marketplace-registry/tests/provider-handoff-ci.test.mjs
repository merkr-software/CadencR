import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  realpathSync,
  symlinkSync,
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
    f.env.HANDOFF_SUPPORT = "yes";
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
    const validation = calls.find((call) => call.includes("validate") && !call.includes("--help"));
    assert.equal(validation.includes("--administrative"), mode === "administrative");
    if (mode === "tooling")
      assert.equal(
        calls.at(-1)[calls.at(-1).indexOf("--provider-handoffs") + 1],
        join(base, "provider-handoffs.json"),
      );
  }
});

test("contribution checks reject incapable pins for base or candidate handoffs", () => {
  for (const location of ["none", "base", "candidate", "broken-candidate"]) {
    for (const capable of [false, true]) {
      const f = fixture();
      const base = join(f.root, "base");
      const candidate = join(f.root, "candidate");
      mkdirSync(base);
      mkdirSync(candidate);
      if (location === "broken-candidate")
        symlinkSync("missing.json", join(candidate, "provider-handoffs.json"));
      else if (location !== "none")
        writeFileSync(join(location === "base" ? base : candidate, "provider-handoffs.json"), "[]");
      f.env.HANDOFF_SUPPORT = capable ? "yes" : "no";
      const result = spawnSync(
        "sh",
        ["scripts/ci/validate-provider-contribution.sh", "pin.env", base, candidate, "validate"],
        { cwd: f.root, env: f.env, encoding: "utf8" },
      );
      assert.equal(result.status === 0, location === "none" || capable, result.stderr);
      if (location !== "none" && !capable)
        assert.match(result.stderr, /lacks qualified provider handoff support/);
    }
  }
});

test("protected preflight diagnoses malformed baseline payloads without inventing history", () => {
  const f = fixture();
  copyFileSync(
    new URL("../scripts/ci/confirm-provider-handoffs.cjs", import.meta.url),
    join(f.root, "scripts/ci/confirm-provider-handoffs.cjs"),
  );
  for (const baseline of [{}, { signed: null }, { signed: [] }, { signed: "invalid" }]) {
    writeFileSync(join(f.root, "baseline.json"), JSON.stringify(baseline));
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        'require("./scripts/ci/confirm-provider-handoffs.cjs").confirmHandoffs({previous_index:"baseline.json",discovery_branch:"marketplace-v2-admin"})',
      ],
      { cwd: f.root, env: f.env, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /previous index must contain a signed payload object/);
    assert.doesNotMatch(result.stderr, /TypeError/);
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
