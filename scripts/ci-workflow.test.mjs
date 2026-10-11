import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../package.json", import.meta.url));
const { parse } = require("yaml");
const workflowsDir = new URL("../.github/workflows/", import.meta.url);
const read = (name) => parse(readFileSync(new URL(name, workflowsDir), "utf8"));
const ci = read("ci.yml");

test("the required 'Pre-commit checks' context aggregates every CI job", () => {
  const [id, aggregator] =
    Object.entries(ci.jobs).find(([, job]) => job.name === "Pre-commit checks") ?? [];
  assert.ok(aggregator, "branch protection on main requires a job named 'Pre-commit checks'");
  assert.equal(aggregator.if, "always()", "a failed dependency must still report a result");
  const others = Object.keys(ci.jobs).filter((name) => name !== id);
  assert.deepEqual([...aggregator.needs].sort(), others.sort());
  const gate = aggregator.steps.map((step) => step.run ?? "").join("\n");
  assert.match(gate, /all\(\.value\.result == "success"\)/);
});

test("PR runs cancel superseded runs; branch pushes never do", () => {
  assert.match(ci.concurrency.group, /pull_request/);
  assert.match(ci.concurrency.group, /github\.sha/);
  assert.equal(ci.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
});

test("every Node setup uses the repo's pinned Node version", () => {
  for (const name of readdirSync(workflowsDir).filter((file) => file.endsWith(".yml"))) {
    for (const [jobId, job] of Object.entries(read(name).jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/setup-node@")) continue;
        assert.equal(step.with?.["node-version"], undefined, `${name}#${jobId} pins node-version`);
        assert.equal(step.with?.["node-version-file"], ".nvmrc", `${name}#${jobId}`);
      }
    }
  }
});

test("third-party actions are pinned to a full commit SHA", () => {
  for (const name of readdirSync(workflowsDir).filter((file) => file.endsWith(".yml"))) {
    for (const [jobId, job] of Object.entries(read(name).jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses || step.uses.startsWith("./")) continue;
        assert.match(step.uses, /@[0-9a-f]{40}$/, `${name}#${jobId} uses ${step.uses}`);
      }
    }
  }
});

test("the Rust job runs fmt, clippy and streamed tests under a step timeout", () => {
  const steps = ci.jobs.rust.steps;
  const runs = steps.map((step) => step.run ?? "").join("\n");
  assert.match(runs, /rustup toolchain install\n/, "toolchain must come from rust-toolchain.toml");
  for (const script of ["format:check", "lint", "test -- --nocapture"]) {
    assert.ok(runs.includes(`pnpm --filter @cadencr/service run ${script}`), script);
  }
  const tests = steps.find((step) => step.run?.includes("run test"));
  assert.ok(tests["timeout-minutes"] > 0);
  assert.ok(steps.some((step) => step.uses?.startsWith("Swatinem/rust-cache@")));
  const { scripts } = JSON.parse(
    readFileSync(new URL("../packages/service/package.json", import.meta.url), "utf8"),
  );
  assert.match(scripts["format:check"], /cargo fmt --all\b/);
  assert.match(scripts.lint, /cargo clippy --workspace --all-targets\b/);
  assert.match(scripts.test, /cargo test --workspace\b/);
});

test("the Web job excludes packages whose checks belong to the Rust workspace", () => {
  const run = ci.jobs.web.steps.find((step) => step.run?.includes("pnpm turbo run"))?.run;
  assert.ok(run, "Web must run its Turbo checks");
  const packagesDir = new URL("../packages/", import.meta.url);
  const webScripts = new Set(["format:check", "lint", "ts-check", "knip"]);
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = new URL(`${entry.name}/package.json`, packagesDir);
    if (!existsSync(manifest)) continue;
    const { name, scripts = {} } = JSON.parse(readFileSync(manifest, "utf8"));
    const runsRust = Object.entries(scripts).some(
      ([script, command]) =>
        webScripts.has(script) && /scripts\/cargo-env\.mjs\s+cargo\b/.test(command),
    );
    if (runsRust) {
      assert.ok(run.includes(`--filter='!${name}'`), `${name} must stay in the Rust job`);
    }
  }
});

test("only branch pushes save the Turbo cache", () => {
  for (const jobId of ["web", "vitest"]) {
    const steps = ci.jobs[jobId].steps;
    assert.ok(
      steps.some((step) => step.uses?.startsWith("actions/cache/restore@")),
      jobId,
    );
    assert.ok(!steps.some((step) => /^actions\/cache@/.test(step.uses ?? "")), jobId);
    const save = steps.find((step) => step.uses?.startsWith("actions/cache/save@"));
    assert.equal(save?.if, "github.event_name != 'pull_request'", jobId);
  }
});

test("CodeQL analyzes PRs into main and the version integration branches", () => {
  const codeql = read("codeql.yml");
  assert.deepEqual(codeql.on.pull_request.branches, ["main", "v*"]);
  assert.deepEqual(codeql.on.push.branches, ["main"]);
  assert.ok(codeql.on.schedule.length > 0);
});
