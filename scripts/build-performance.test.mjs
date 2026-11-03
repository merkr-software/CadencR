import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const workflow = (name) => parseYaml(read(`.github/workflows/${name}.yml`));

test("local packaging preserves release semantics with an isolated, cheaper profile", () => {
  const { profile } = parseToml(read("Cargo.toml"));
  assert.equal(profile.local.inherits, "release");
  assert.equal(profile.local.lto, false);
  assert.ok(profile.local["codegen-units"] > 1);
  assert.equal(profile.local["debug-assertions"], undefined);
  assert.equal(profile.release["debug-assertions"], undefined);
  assert.equal(profile.release.lto, "thin");
  assert.equal(profile.release["codegen-units"], 1);
  assert.equal(profile.release.panic, undefined, "keep unwind for task panic boundaries");
});

test("the macOS Turbo graph builds the local sidecar without a redundant release build", () => {
  const dry = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/turbo/bin/turbo"),
        "run",
        "build:local",
        "--filter=@cadencr/desktop",
        "--dry=json",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" } },
    ),
  );
  const desktop = dry.tasks.find((task) => task.taskId === "@cadencr/desktop#build:local");
  assert.ok(desktop.dependencies.includes("@cadencr/service#build:local"));
  assert.ok(!dry.tasks.some((task) => task.taskId === "@cadencr/service#build"));
  const service = dry.tasks.find((task) => task.taskId === "@cadencr/service#build:local");
  assert.equal(service.resolvedTaskDefinition.cache, false);
  assert.match(service.command, /--profile local --bin cadencr-service/);
});

test("Linux local packaging uses the same profile; production only builds the shipped binary", () => {
  const service = json("packages/service/package.json").scripts;
  const desktop = json("packages/desktop/package.json").scripts;
  assert.match(desktop["build:local:linux"], /@cadencr\/service build:local &&/);
  assert.match(service.build, /--locked --release --bin cadencr-service/);
  assert.match(
    read("packages/service/scripts/build-macos-sidecars.mjs"),
    /"--bin", "cadencr-service"/,
  );
  assert.match(desktop.build, /@cadencr\/service build:sidecars/);
});

test("binary staging reads the selected profile and never silently packages a stale release", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cadencr-build-profiles-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "packages/service");
  mkdirSync(cwd, { recursive: true });
  const target = join(dir, "target");
  for (const profile of ["release", "local", "debug"]) {
    mkdirSync(join(target, profile), { recursive: true });
    writeFileSync(join(target, profile, "cadencr-service"), profile);
  }
  const run = (profile) =>
    spawnSync(
      process.execPath,
      [join(root, "packages/service/scripts/copy-service-binary.mjs"), profile],
      { cwd, env: { ...process.env, CARGO_TARGET_DIR: target }, encoding: "utf8" },
    );
  const staged = join(dir, "packages/desktop/resources/bin");
  for (const profile of ["release", "local", "debug"]) {
    const result = run(profile);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(staged, "cadencr-service"), "utf8"), profile);
    assert.equal(readFileSync(join(staged, process.arch, "cadencr-service"), "utf8"), profile);
  }
  assert.notEqual(run("typo").status, 0);
  rmSync(join(target, "local/cadencr-service"));
  assert.notEqual(run("local").status, 0);
  assert.equal(readFileSync(join(staged, "cadencr-service"), "utf8"), "debug");
});

test("release caches are seeded on main using matching runners, profiles and target layouts", () => {
  const warm = workflow("release-rust-cache");
  assert.deepEqual(warm.on.push.branches, ["main"]);
  assert.equal(warm.jobs.warm.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(warm.permissions, { contents: "read" });
  const steps = warm.jobs.warm.steps;
  const cache = steps.find((step) => step.uses?.startsWith("Swatinem/rust-cache@"));
  assert.ok(
    steps.findIndex((step) => step.run === "rustup toolchain install") < steps.indexOf(cache),
  );
  assert.equal(cache.with["shared-key"], "desktop-release-${{ matrix.os }}");
  assert.equal(cache.with["cache-workspace-crates"], undefined);
  const build = steps.find((step) => step.name === "Compile release dependencies");
  assert.match(build.run, /--locked --release -p cadencr-service --lib --target/);
  assert.match(build.run, /--locked --release -p cadencr-service --lib\n/);
  assert.doesNotMatch(JSON.stringify(warm), /secrets\./);

  for (const [name, job] of [
    ["desktop-release", "release"],
    ["desktop-linux-release", "build"],
  ]) {
    const release = workflow(name).jobs[job];
    assert.ok(warm.jobs.warm.strategy.matrix.os.includes(release["runs-on"]));
    const restored = release.steps.find((step) => step.uses?.startsWith("Swatinem/rust-cache@"));
    assert.equal(restored.uses, cache.uses);
    assert.equal(restored.with["shared-key"], `desktop-release-${release["runs-on"]}`);
    assert.equal(restored.with["save-if"], "false", "avoid caches stranded on version tags");
    assert.ok(
      release.steps.indexOf(restored) <
        release.steps.findIndex((step) => step.name?.startsWith("Build Rust")),
    );
  }
});

test("cache warming compiles both macOS targets serially and the Linux host, stopping on failure", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cadencr-cache-warm-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, "calls");
  for (const command of ["pnpm", "rustup"]) {
    writeFileSync(
      join(dir, command),
      `#!/bin/sh
printf '${command}:%s\\n' "$*" >> "$CALL_LOG"
exit "${command === "pnpm" ? "$BUILD_EXIT" : "0"}"
`,
      { mode: 0o755 },
    );
  }
  const step = workflow("release-rust-cache").jobs.warm.steps.find(
    (entry) => entry.name === "Compile release dependencies",
  );
  const base = "pnpm:rust -- build --locked --release -p cadencr-service --lib";
  for (const os of ["macOS", "Linux"]) {
    for (const exitCode of [0, 23]) {
      writeFileSync(calls, "");
      const env = {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_OS: os,
        CALL_LOG: calls,
        BUILD_EXIT: String(exitCode),
      };
      delete env.BASH_ENV;
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, exitCode, result.stderr);
      const expected =
        os === "Linux"
          ? [base]
          : [
              "rustup:target add aarch64-apple-darwin x86_64-apple-darwin",
              `${base} --target aarch64-apple-darwin`,
              ...(exitCode === 0 ? [`${base} --target x86_64-apple-darwin`] : []),
            ];
      assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), expected);
    }
  }
});
