import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { signalGroups } from "./dev-cleanup.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const WAITING = /Waiting for the shared Rust precompile slot/;
const PRECOMPILE = ["bash", "scripts/precompile-dev.sh"];
const CARGO_CHECK = [process.execPath, "scripts/cargo-env.mjs", "cargo", "check"];
const fixtureEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && name !== "BASH_ENV"),
);
const qaBuild = (marketplace) => [
  process.execPath,
  "--input-type=module",
  "--eval",
  `import { build } from './scripts/isolated-qa/build.mjs';
   build({ repoRoot: process.cwd(), surface: 'service', marketplace: ${marketplace} });`,
];

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: fixtureEnv });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rust-precompile-test-")));
  const main = join(root, "main");
  const linked = join(root, "linked tree");
  const bin = join(root, "bin");
  const active = new Set();
  const key = createHash("sha256").update(join(main, ".git")).digest("hex").slice(0, 16);
  t.after(async () => {
    signalGroups([...active].map(({ child }) => child.pid).filter(Boolean), "SIGKILL");
    await Promise.all([...active].map(({ done }) => done));
    rmSync(`/tmp/cadencr-rust-precompile-${process.getuid()}-${key}.lock`, { force: true });
    rmSync(root, { force: true, recursive: true });
  });
  mkdirSync(main);
  mkdirSync(bin);
  git(main, "init", "-q", "-b", "main");
  git(
    main,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Fixture",
  );
  git(main, "worktree", "add", "-q", "--detach", linked);

  for (const tree of [main, linked]) {
    const dir = join(tree, "scripts");
    mkdirSync(join(dir, "isolated-qa"), { recursive: true });
    for (const file of [
      "precompile-dev.sh",
      "precompile-dev.mjs",
      "cargo-env.mjs",
      "disk-space.mjs",
      "git-worktrees.mts",
      "isolated-qa/build.mjs",
    ]) {
      copyFileSync(join(scripts, file), join(dir, file));
    }
    // Stub QA prerequisites so these processes exercise the build path without starting the app.
    writeFileSync(
      join(dir, "doctor.mjs"),
      `
      export const gatherFacts = () => ({ env: { service: true, desktop: true } });
      export const evaluateForQa = () => [];
      export const formatReport = () => '';
    `,
    );
    writeFileSync(
      join(dir, "build-local.mjs"),
      "export const fetchBuildEnv = () => ({ env: { ...process.env }, configured: true });\n",
    );
    writeFileSync(
      join(dir, "isolated-qa/processes.mjs"),
      "export const lsofCommand = () => 'true';\n",
    );
  }
  writeFileSync(
    join(bin, "cargo"),
    `#!/usr/bin/env bash
set -eu
if [[ -n "$BUILD_EVENTS" ]]; then printf 'start %s\n' "$$" >> "$BUILD_EVENTS"; fi
printf 'cargo %s | %s\n' "$*" "$CARGO_TARGET_DIR"
if [[ -n "$HOLD_BUILD" ]]; then
  while [[ ! -f "$HOLD_BUILD" ]]; do sleep 0.05; done
fi
if [[ -n "$BUILD_EVENTS" ]]; then printf 'finish %s\n' "$$" >> "$BUILD_EVENTS"; fi
exit "$BUILD_EXIT"
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env bash
set -eu
if [[ "$1" == dev:precompile ]]; then exec bash scripts/precompile-dev.sh; fi
printf '%s | %s\n' "$*" "$CARGO_TARGET_DIR" > "$BUILD_COPY"
`,
    { mode: 0o700 },
  );

  function start(cwd, [command, ...args], env = {}) {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: {
        ...fixtureEnv,
        PATH: [bin, dirname(process.execPath), process.env.PATH].join(":"),
        CADENCR_MIN_FREE_DISK_GIB: "0",
        CARGO_TARGET_DIR: join(root, "shared-target"),
        HOLD_BUILD: "",
        BUILD_EXIT: "0",
        BUILD_EVENTS: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const job = {
      child,
      get output() {
        return `${stdout}\n${stderr}`;
      },
      done: once(child, "close"),
    };
    active.add(job);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", () => active.delete(job));
    return job;
  }
  return { main, linked, start, gate: join(root, "release"), events: join(root, "events") };
}

async function waitForOutput(job, pattern) {
  const deadline = Date.now() + 8_000;
  while (
    !pattern.test(job.output) &&
    job.child.exitCode === null &&
    job.child.signalCode === null &&
    Date.now() < deadline
  ) {
    await delay(25);
  }
  assert.match(job.output, pattern);
}

test(
  "dev and QA builds share one slot across worktrees and Cargo checks can proceed",
  { timeout: 20_000 },
  async (t) => {
    const { main, linked, start, gate, events } = fixture(t);
    const holder = start(main, PRECOMPILE, {
      HOLD_BUILD: gate,
      BUILD_EXIT: "23",
      BUILD_EVENTS: events,
    });
    await waitForOutput(holder, /^cargo build --quiet -p claude-agent-sdk-rs/m);
    const copy = join(linked, "copied-command");
    const qa = start(linked, qaBuild(false), { BUILD_EVENTS: events, BUILD_COPY: copy });
    const marketplace = start(linked, qaBuild(true), { TMPDIR: linked, BUILD_EVENTS: events });
    const lowDisk = start(linked, PRECOMPILE, { CADENCR_MIN_FREE_DISK_GIB: "1000000" });
    await Promise.all([qa, marketplace, lowDisk].map((job) => waitForOutput(job, WAITING)));
    assert.doesNotMatch(qa.output + marketplace.output + lowDisk.output, /^cargo build/m);

    const check = start(linked, CARGO_CHECK);
    assert.deepEqual(await check.done, [0, null], check.output);
    assert.ok(check.output.includes(`cargo check | ${join(linked, "target")}\n`));
    assert.ok(holder.output.includes(` | ${join(main, "target")}\n`));

    writeFileSync(gate, "");
    assert.deepEqual(await holder.done, [23, null], holder.output);
    assert.deepEqual(await qa.done, [0, null], qa.output);
    assert.deepEqual(await marketplace.done, [0, null], marketplace.output);
    assert.deepEqual(await lowDisk.done, [1, null], lowDisk.output);
    assert.match(lowDisk.output, /pnpm dev:precompile: only .* GiB free/);
    assert.doesNotMatch(lowDisk.output, /^cargo build/m);
    assert.ok(
      qa.output.includes(`cargo build --quiet -p cadencr-service | ${join(linked, "target")}\n`),
    );
    assert.ok(existsSync(copy), qa.output);
    assert.equal(
      readFileSync(copy, "utf8"),
      `--silent --filter @cadencr/service copy:debug | ${join(linked, "target")}\n`,
      qa.output,
    );
    assert.ok(
      marketplace.output.includes(`--target-dir ${join(linked, "target", "qa-marketplace")} | `),
    );
    const steps = readFileSync(events, "utf8").trim().split("\n");
    assert.equal(steps.length, 8);
    for (let index = 0; index < steps.length; index += 2) {
      const [, pid] = steps[index].split(" ");
      assert.equal(steps[index], `start ${pid}`);
      assert.equal(steps[index + 1], `finish ${pid}`);
    }
  },
);

test("cancelling a build frees its slot after Cargo stops", { timeout: 20_000 }, async (t) => {
  const { main, linked, start, gate } = fixture(t);
  const holder = start(main, PRECOMPILE, { HOLD_BUILD: gate });
  await waitForOutput(holder, /^cargo build/m);

  const exited = once(holder.child, "exit");
  holder.child.kill("SIGKILL");
  assert.deepEqual(await exited, [null, "SIGKILL"]);
  const next = start(linked, PRECOMPILE, { BUILD_COPY: join(linked, "copied-command") });
  await waitForOutput(next, WAITING);
  assert.doesNotMatch(next.output, /^cargo build/m);

  process.kill(-holder.child.pid, "SIGTERM");
  assert.deepEqual(await next.done, [0, null], next.output);
  assert.match(next.output, /Rust development targets are ready/);
});
