// Read-only report of SQLite databases and their backup snapshots: per-worktree
// dev databases and the installed app's database directory. Nothing here ever
// deletes or modifies a database file (see .claude/rules/no-destructive-ops.md);
// it only names what takes space so the user can decide.
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BACKUP_SUFFIX = ".cadencr.backup.db";
// Mirrors parse_snapshot in packages/service/src/shared/migrate/backup_rotation/naming.rs:
// `db-<hex identity>.<version>.<timestamp>.cadencr.backup.db`.
const MANAGED_BACKUP = /^db-(?:[0-9a-f]{2})+\.[^.]+(?:\.[^.]+)*\.[^.]+\.cadencr\.backup\.db$/;

/**
 * Classify one file name found next to a database.
 * - `live`: a database the service opens.
 * - `managed-backup`: a pre-migration snapshot the service rotates (newest per
 *   version, two versions kept).
 * - `unmanaged-backup`: a legacy snapshot without a source identity. The
 *   service deliberately never rotates these, so they stay until removed by hand.
 * - `manual-backup`: a hand-made copy such as `cadencr.db.bck`.
 * Returns `null` for anything else (WAL/SHM siblings included).
 */
export function classifyDatabaseFile(name) {
  if (name.endsWith(BACKUP_SUFFIX)) {
    return MANAGED_BACKUP.test(name) ? "managed-backup" : "unmanaged-backup";
  }
  if (/\.db\.(bck|bak|backup)$/.test(name)) return "manual-backup";
  if (name.endsWith(".db")) return "live";
  return null;
}

/** Sum file sizes per kind; `files` is `{ name, size }[]`. */
export function summarizeDatabaseFiles(files) {
  const summary = { live: 0, "managed-backup": 0, "unmanaged-backup": 0, "manual-backup": 0 };
  const unmanaged = [];
  for (const { name, size } of files) {
    const kind = classifyDatabaseFile(name);
    if (!kind) continue;
    summary[kind] += size;
    if (kind === "unmanaged-backup" || kind === "manual-backup") unmanaged.push({ name, size });
  }
  return { summary, unmanaged };
}

function listFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, size: lstatSync(join(directory, entry.name)).size }));
}

/** Database directories worth reporting: each worktree's service dir, then the app's. */
export function databaseDirectories(worktrees, home = homedir()) {
  return [
    ...worktrees.map((worktree) => ({
      label: worktree,
      dir: join(worktree, "packages", "service"),
    })),
    { label: "installed app (~/.cadencr/database)", dir: join(home, ".cadencr", "database") },
  ];
}

export function printDatabaseReport(worktrees, formatBytes) {
  console.log("\nDatabases and backups (logical sizes; APFS clones share blocks):");
  let reclaimable = 0;
  for (const { label, dir } of databaseDirectories(worktrees)) {
    const { summary, unmanaged } = summarizeDatabaseFiles(listFiles(dir));
    const total = Object.values(summary).reduce((sum, size) => sum + size, 0);
    if (total === 0) continue;
    const parts = [
      `live ${formatBytes(summary.live)}`,
      `rotated backups ${formatBytes(summary["managed-backup"])}`,
    ];
    const extra = summary["unmanaged-backup"] + summary["manual-backup"];
    if (extra > 0) parts.push(`never-rotated backups ${formatBytes(extra)}`);
    console.log(`${formatBytes(total).padStart(10)}  ${label}  (${parts.join(", ")})`);
    for (const file of unmanaged) {
      console.log(`${"".padStart(12)}- ${formatBytes(file.size)}  ${join(dir, file.name)}`);
    }
    reclaimable += extra;
  }
  if (reclaimable > 0) {
    console.log(
      `\n${formatBytes(reclaimable)} sits in backups the service never rotates (legacy or hand-made).` +
        "\nThey are never deleted automatically: check you no longer need them, then remove them yourself.",
    );
  }
}
