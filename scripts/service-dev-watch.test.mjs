import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  INSTALL_HINT,
  RUN_ARGS,
  buildWatchCommand,
  buildWatchPaths,
  collectPathDependencyDirs,
  executableOnPath,
  parsePathDependencies,
  pickWatcher,
} from "./service-dev-watch.mjs";

const SERVICE_MANIFEST = `
[package]
name = "cadencr-service"

[dependencies]
claude-agent-sdk-rs = { path = "../claude-agent-sdk-rs" }
tokio = { version = "1", features = ["full"] }
portable-pty = { path = "vendor/portable-pty" } # vendored

[dependencies.cursor-agent-sdk-rs]
path = "../cursor-agent-sdk-rs"

[target.'cfg(windows)'.dependencies]
win-only = { path = "../win-only" }

[[bin]]
name = "dump-openapi"
path = "src/bin/dump_openapi.rs"

[dev-dependencies]
test-helper = { path = "../test-helper" }
`;

test("parses path dependencies from every non-dev dependency table", () => {
  assert.deepEqual(parsePathDependencies(SERVICE_MANIFEST), [
    "../claude-agent-sdk-rs",
    "vendor/portable-pty",
    "../cursor-agent-sdk-rs",
    "../win-only",
  ]);
});

test("collects transitive path dependencies once each", () => {
  const manifests = {
    "/repo/packages/service/Cargo.toml":
      '[dependencies]\na = { path = "../a" }\nb = { path = "../b" }\n',
    "/repo/packages/a/Cargo.toml": '[dependencies]\nshared = { path = "../shared" }\n',
    "/repo/packages/b/Cargo.toml": '[dependencies]\nshared = { path = "../shared" }\n',
    "/repo/packages/shared/Cargo.toml": '[dependencies]\nserde = "1"\n',
  };
  const dirs = collectPathDependencyDirs("/repo/packages/service", (path) => manifests[path]);

  assert.deepEqual(dirs, ["/repo/packages/a", "/repo/packages/b", "/repo/packages/shared"]);
});

test("watches the service, its migrations, the workspace manifests and every dependency crate", () => {
  const paths = buildWatchPaths({
    repoRoot: "/repo",
    serviceDir: join("/repo", "packages", "service"),
    dependencyDirs: ["/repo/packages/claude-agent-sdk-rs", "/repo/packages/service/vendor/pty"],
  });

  assert.deepEqual(paths, [
    "src",
    "migrations",
    ".env",
    "Cargo.toml",
    join("..", "..", "Cargo.toml"),
    join("..", "..", "Cargo.lock"),
    join("..", "claude-agent-sdk-rs", "src"),
    join("..", "claude-agent-sdk-rs", "Cargo.toml"),
    join("vendor", "pty", "src"),
    join("vendor", "pty", "Cargo.toml"),
  ]);
});

test("builds a restarting watchexec invocation", () => {
  const { command, args } = buildWatchCommand("watchexec", ["src", ".env"]);

  assert.equal(command, "watchexec");
  assert.deepEqual(args, [
    "--restart",
    "--no-project-ignore",
    "--watch",
    "src",
    "--watch",
    ".env",
    "--",
    "cargo",
    ...RUN_ARGS,
  ]);
});

test("builds the cargo-watch fallback invocation", () => {
  const { command, args } = buildWatchCommand("cargo-watch", ["src", ".env"]);

  assert.equal(command, "cargo");
  assert.deepEqual(args, [
    "watch",
    "--no-vcs-ignores",
    "-w",
    "src",
    "-w",
    ".env",
    "-x",
    "run --bin cadencr-service",
  ]);
});

test("rejects an unknown watcher", () => {
  assert.throws(() => buildWatchCommand("nodemon", ["src"]), /unknown watcher/);
});

test("prefers watchexec, falls back to cargo-watch, else reports nothing", () => {
  assert.equal(
    pickWatcher(() => true),
    "watchexec",
  );
  assert.equal(
    pickWatcher((name) => name === "cargo-watch"),
    "cargo-watch",
  );
  assert.equal(
    pickWatcher(() => false),
    null,
  );
});

test("install hint names both install routes", () => {
  assert.match(INSTALL_HINT, /cargo install watchexec-cli --locked/);
  assert.match(INSTALL_HINT, /brew install watchexec/);
});

test("executableOnPath returns the first executable match and skips non-executable files", () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-watch-"));
  try {
    for (const dir of ["a", "b", "c"]) mkdirSync(join(root, dir));
    writeFileSync(join(root, "a", "watchexec"), "");
    chmodSync(join(root, "a", "watchexec"), 0o644);
    mkdirSync(join(root, "b", "watchexec"));
    writeFileSync(join(root, "c", "watchexec"), "");
    chmodSync(join(root, "c", "watchexec"), 0o755);
    const env = { PATH: ["", "a", "b", "c"].map((dir) => dir && join(root, dir)).join(delimiter) };
    assert.equal(executableOnPath("watchexec", env, "linux"), join(root, "c", "watchexec"));
    assert.equal(executableOnPath("cargo-watch", env, "linux"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executableOnPath tries each PATHEXT extension on Windows", () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-watch-"));
  try {
    writeFileSync(join(root, "watchexec.EXE"), "");
    const env = { PATH: root, PATHEXT: ".COM;.EXE" };
    assert.equal(executableOnPath("watchexec", env, "win32"), join(root, "watchexec.EXE"));
    assert.equal(executableOnPath("watchexec", { PATH: root, PATHEXT: ".COM" }, "win32"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
