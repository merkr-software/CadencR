import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  classifyDatabaseFile,
  databaseDirectories,
  summarizeDatabaseFiles,
} from "./dev-db-storage.mjs";

test("classifies the backup shapes the service writes and the legacy ones it never rotates", () => {
  const cases = {
    "cadencr.local.db": "live",
    "cadencr.db": "live",
    "db-636164656e63722e6462.0.12.0.2026-10-10-09-33-43-9ff74d7c21ff43ddbc35b8cd3b7297f5.cadencr.backup.db":
      "managed-backup",
    "0.10.0.2026-08-08-10.cadencr.backup.db": "unmanaged-backup",
    "unknown.2026-06-13-10.cadencr.backup.db": "unmanaged-backup",
    "db-zz.0.1.0.2026-01-01-00.cadencr.backup.db": "unmanaged-backup",
    "cadencr.db.bck": "manual-backup",
    "cadencr.db-wal": null,
    "cadencr.db-shm": null,
    ".env": null,
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(classifyDatabaseFile(name), expected, name);
  }
});

test("summarizes sizes per kind and lists only the backups needing a manual decision", () => {
  const { summary, unmanaged } = summarizeDatabaseFiles([
    { name: "cadencr.db", size: 10 },
    { name: "cadencr.db-wal", size: 1 },
    { name: "db-6162.0.12.0.2026-10-10-09-33-43-ab.cadencr.backup.db", size: 20 },
    { name: "0.9.1.2026-08-02-19.cadencr.backup.db", size: 30 },
    { name: "cadencr.db.bck", size: 40 },
  ]);
  assert.deepEqual(summary, {
    live: 10,
    "managed-backup": 20,
    "unmanaged-backup": 30,
    "manual-backup": 40,
  });
  assert.deepEqual(
    unmanaged.map((file) => file.name),
    ["0.9.1.2026-08-02-19.cadencr.backup.db", "cadencr.db.bck"],
  );
});

test("reports each worktree's service directory and the installed app's database directory", () => {
  assert.deepEqual(databaseDirectories(["/repo", "/wt/a"], "/home/me"), [
    { label: "/repo", dir: join("/repo", "packages", "service") },
    { label: "/wt/a", dir: join("/wt/a", "packages", "service") },
    { label: "installed app (~/.cadencr/database)", dir: join("/home/me", ".cadencr", "database") },
  ]);
});
