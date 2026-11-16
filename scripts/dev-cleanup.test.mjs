import assert from "node:assert/strict";
import test from "node:test";
import { collectDevProcessGroups, remainingDevProcessGroups } from "./dev-cleanup.mjs";

const repoRoot = "/repo/cadencr";

test("collectDevProcessGroups tracks only descendants of this dev launcher", () => {
  const rows = [
    {
      pid: 100,
      ppid: 1,
      pgid: 100,
      command: `node ${repoRoot}/scripts/dev.mjs`,
    },
    {
      pid: 101,
      ppid: 100,
      pgid: 101,
      command: `node ${repoRoot}/scripts/cargo-env.mjs turbo run dev`,
    },
    {
      pid: 102,
      ppid: 101,
      pgid: 101,
      command: `node ${repoRoot}/node_modules/.bin/turbo run dev`,
    },
    {
      pid: 103,
      ppid: 102,
      pgid: 200,
      command: `node ${repoRoot}/packages/desktop/scripts/electron-vite.mjs dev`,
    },
    {
      pid: 104,
      ppid: 103,
      pgid: 200,
      command: `${repoRoot}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`,
    },
    {
      pid: 105,
      ppid: 102,
      pgid: 300,
      command: `/home/dev/.cargo/bin/cargo-watch watch -w src -w .env -x run --bin cadencr-service`,
    },
    {
      pid: 106,
      ppid: 105,
      pgid: 301,
      command: `${repoRoot}/target/debug/cadencr-service`,
    },
    {
      pid: 201,
      ppid: 1,
      pgid: 201,
      command: `${repoRoot}/node_modules/@turbo/darwin-arm64/bin/turbo run dev`,
    },
    {
      pid: 202,
      ppid: 1,
      pgid: 202,
      command: `${repoRoot}/target/debug/cadencr-service`,
    },
    {
      pid: 203,
      ppid: 1,
      pgid: 203,
      command: `/other/repo/target/debug/cadencr-service`,
    },
    {
      pid: 204,
      ppid: 1,
      pgid: 204,
      command: "/Applications/Cadencr.app/Contents/Resources/cadencr-service --port 5004",
    },
  ];

  assert.deepEqual(collectDevProcessGroups(rows, repoRoot, 99999, 101), [101, 200, 300, 301]);
});

test("remainingDevProcessGroups keeps only observed groups that still host dev tasks", () => {
  const rows = [
    {
      pid: 300,
      ppid: 1,
      pgid: 101,
      command: "/bin/zsh",
    },
    {
      pid: 301,
      ppid: 1,
      pgid: 200,
      command: `${repoRoot}/target/debug/cadencr-service`,
    },
    {
      pid: 302,
      ppid: 1,
      pgid: 301,
      command: `/other/repo/target/debug/cadencr-service`,
    },
    {
      pid: 303,
      ppid: 1,
      pgid: 300,
      command: `/home/dev/.cargo/bin/cargo-watch watch -w src -w .env -x run --bin cadencr-service`,
    },
  ];

  assert.deepEqual(remainingDevProcessGroups(rows, [101, 200, 300]), [200, 300]);
});

test("matches the watchexec-based service watcher and its node wrapper", () => {
  const rows = [
    { pid: 10, ppid: 1, pgid: 10, command: `node ${repoRoot}/scripts/service-dev-watch.mjs` },
    {
      pid: 11,
      ppid: 10,
      pgid: 11,
      command:
        "watchexec --restart --no-project-ignore --watch src -- cargo run --bin cadencr-service",
    },
    { pid: 12, ppid: 1, pgid: 12, command: "watchexec --watch src -- make" },
  ];
  assert.deepEqual(collectDevProcessGroups(rows, repoRoot, 999, 10), [10, 11]);
});
