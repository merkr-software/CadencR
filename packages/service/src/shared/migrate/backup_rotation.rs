//! Prunes stale pre-migration backup snapshots.
//!
//! `support::backup_database` writes a `VACUUM INTO` snapshot before each
//! migrating launch and, until this module existed, never removed one. Those
//! snapshots are full copies of the database: on a real installation two of them
//! held 10.6 GB of a 15 GB database directory — more than the live database
//! itself.
//!
//! The retained set is the newest snapshot of each of the
//! [`KEEP_VERSIONS`] most recently backed-up app versions. Keying on version
//! rather than on file count is what makes the set useful: several snapshots of
//! the same version are near-duplicates of each other, while the point of
//! keeping a backup at all is to be able to fall back across an upgrade.
//!
//! Safety rules, in order of importance:
//! - The live database is excluded by path, never by naming convention. A user
//!   restoring a snapshot points `CADENCR_DB_PATH` at it, which makes the live
//!   database a file whose name matches the backup shape exactly; relying on the
//!   name alone would delete the database out from under a running app.
//! - Only files matching the exact `{version}.{timestamp}{BACKUP_SUFFIX}` shape
//!   in the database's own directory are ever considered, so the `-wal`/`-shm`
//!   siblings and unrelated files can't match.
//! - The snapshot just written is always retained, even if the parse of its
//!   name somehow disagrees with the caller.
//! - A failed delete is logged and skipped; rotation never fails a migration.

use std::collections::HashMap;
use std::path::Path;

pub(super) mod naming;
use naming::{database_identity, parse_snapshot, Snapshot};

/// Number of distinct app versions to keep snapshots for.
const KEEP_VERSIONS: usize = 2;

/// Decide which snapshots to delete: everything except the newest snapshot of
/// each of the `KEEP_VERSIONS` most recently backed-up versions, and never
/// `live` — the database currently open.
///
/// Split out from the filesystem walk so the policy is testable without
/// creating multi-GB files.
fn select_prunable(snapshots: Vec<Snapshot>, keep: &Path, live: &Path) -> Vec<Snapshot> {
    let mut newest_per_version: HashMap<&str, &Snapshot> = HashMap::new();
    for snapshot in &snapshots {
        newest_per_version
            .entry(snapshot.version.as_str())
            .and_modify(|current| {
                if snapshot.timestamp > current.timestamp {
                    *current = snapshot;
                }
            })
            .or_insert(snapshot);
    }

    let mut keepers: Vec<&Snapshot> = newest_per_version.into_values().collect();
    // Newest version first; tie-break on version so the choice is deterministic
    // when two versions were backed up within the same hour.
    keepers.sort_by(|a, b| {
        b.timestamp
            .cmp(&a.timestamp)
            .then_with(|| b.version.cmp(&a.version))
    });
    let retained: Vec<&Path> = keepers
        .into_iter()
        .take(KEEP_VERSIONS)
        .map(|snapshot| snapshot.path.as_path())
        .collect();

    snapshots
        .iter()
        .filter(|snapshot| {
            snapshot.path != keep
                && snapshot.path != live
                && !retained.contains(&snapshot.path.as_path())
        })
        .cloned()
        .collect()
}

/// Remove stale snapshots alongside `db_path`, never touching `just_written` or
/// `db_path` itself. Returns the number of files removed.
pub(super) fn prune(db_path: &Path, just_written: &Path) -> usize {
    let Some(dir) = db_path.parent() else {
        return 0;
    };
    // Pruning is housekeeping: a failure keeps old backups on disk, so it is
    // logged for the user who wonders where the space went.
    let canonical_dir = match std::fs::canonicalize(dir) {
        Ok(dir) => dir,
        Err(error) => {
            tracing::warn!(dir = %dir.display(), %error, "cannot prune database backups");
            return 0;
        }
    };
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(dir = %dir.display(), %error, "cannot list database backups to prune");
            return 0;
        }
    };

    // Resolve protected paths only for identity comparison. Candidate paths stay
    // as the directory entries returned by `read_dir`: deleting a canonicalized
    // candidate would follow a symlink and could unlink a target outside this
    // directory instead of removing the entry we inspected.
    let canonical_live = std::fs::canonicalize(db_path).ok();
    let canonical_keep = std::fs::canonicalize(just_written).ok();

    let Some(identity) = database_identity(db_path) else {
        return 0;
    };
    let snapshots: Vec<Snapshot> = entries
        .flatten()
        // `DirEntry::file_type` is an lstat-style check: unlike `Path::is_file`
        // it does not follow symlinks. Rotation never needs to touch symlinks.
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .filter(|path| {
            let Ok(resolved) = std::fs::canonicalize(path) else {
                return false;
            };
            resolved.parent() == Some(canonical_dir.as_path())
                && canonical_live.as_ref() != Some(&resolved)
        })
        .filter_map(|path| parse_snapshot(&path))
        .filter(|snapshot| snapshot.identity == identity)
        .collect();

    let mut removed = 0;
    for snapshot in select_prunable(snapshots, just_written, db_path) {
        let resolved = std::fs::canonicalize(&snapshot.path).ok();
        if resolved.as_ref().is_some_and(|path| {
            canonical_live.as_ref() == Some(path) || canonical_keep.as_ref() == Some(path)
        }) {
            continue;
        }
        match std::fs::remove_file(&snapshot.path) {
            Ok(()) => {
                removed += 1;
                tracing::info!(
                    snapshot = %snapshot.path.display(),
                    "removed superseded pre-migration backup"
                );
            }
            Err(e) => tracing::warn!(
                snapshot = %snapshot.path.display(),
                "failed to remove superseded backup: {e}"
            ),
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const IDENTITY: &str = "db-636164656e63722e6462"; // cadencr.db

    fn name(version: &str, timestamp: &str) -> String {
        format!("{IDENTITY}.{version}.{timestamp}{}", naming::BACKUP_SUFFIX)
    }

    fn snapshot(version: &str, timestamp: &str) -> Snapshot {
        Snapshot {
            path: PathBuf::from("/db").join(name(version, timestamp)),
            identity: IDENTITY.to_string(),
            version: version.to_string(),
            timestamp: timestamp.to_string(),
        }
    }

    /// `/db/cadencr.db` stands in for the live database in the common case: a
    /// name that can't parse as a snapshot, so the policy is exercised on its
    /// own terms. `pruned_names_with_live` covers the case where it can.
    fn pruned_names(snapshots: Vec<Snapshot>, keep: &str) -> Vec<String> {
        pruned_names_with_live(snapshots, keep, "/db/cadencr.db")
    }

    fn pruned_names_with_live(snapshots: Vec<Snapshot>, keep: &str, live: &str) -> Vec<String> {
        let mut names: Vec<String> = select_prunable(snapshots, Path::new(keep), Path::new(live))
            .into_iter()
            .map(|s| s.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The live database is excluded by path, not by how it happens to be named.
    ///
    /// Restoring a snapshot means pointing `CADENCR_DB_PATH` at it, so the live
    /// database is then a file that parses as a snapshot like any other. Before
    /// this guard, the second migrating launch after such a restore unlinked the
    /// database the app was running on.
    #[test]
    fn never_prunes_the_live_database_even_when_it_is_named_like_a_snapshot() {
        let live_name = name("0.9.1", "2026-07-31-22");
        let live = format!("/db/{live_name}");
        let snapshots = vec![
            snapshot("0.9.1", "2026-07-31-22"),
            snapshot("0.9.2", "2026-08-01-10"),
            snapshot("0.9.3", "2026-08-02-10"),
            snapshot("0.10.0", "2026-08-03-09"),
        ];
        let keep_name = name("0.10.0", "2026-08-03-09");
        let keep = format!("/db/{keep_name}");

        let names = pruned_names_with_live(snapshots, &keep, &live);

        assert_eq!(names, vec![name("0.9.2", "2026-08-01-10")]);
    }

    #[test]
    fn parses_a_dotted_version_and_timestamp() {
        let path = PathBuf::from("/db").join(name("0.9.1", "2026-07-31-22"));
        let parsed = parse_snapshot(&path).unwrap();
        assert_eq!(parsed.version, "0.9.1");
        assert_eq!(parsed.timestamp, "2026-07-31-22");
    }

    #[test]
    fn ignores_everything_that_is_not_a_snapshot() {
        // The live database and its siblings must never parse as candidates.
        for name in [
            "/db/cadencr.db",
            "/db/cadencr.db-wal",
            "/db/cadencr.db-shm",
            "/db/0.9.1.2026-07-31-22.cadencr.backup.db.partial",
            "/db/0.9.1.not-a-timestamp.cadencr.backup.db",
            "/db/0.9.1.2026-99-99-99.cadencr.backup.db",
            "/db/arbitrary name.2026-07-31-22.cadencr.backup.db",
            "/db/.hidden.2026-07-31-22.cadencr.backup.db",
            "/db/notes.txt",
            "/db/.cadencr.backup.db",
        ] {
            assert!(
                parse_snapshot(Path::new(name)).is_none(),
                "{name} must not parse as a snapshot"
            );
        }
    }

    #[test]
    fn keeps_the_newest_snapshot_of_the_two_newest_versions() {
        let snapshots = vec![
            snapshot("0.9.1", "2026-08-02-19"),
            snapshot("0.9.0", "2026-07-01-08"),
            snapshot("0.8.0", "2026-06-01-08"),
        ];
        assert_eq!(
            pruned_names(snapshots, "/db/none"),
            vec![name("0.8.0", "2026-06-01-08")]
        );
    }

    #[test]
    fn collapses_multiple_snapshots_of_one_version_to_the_newest() {
        // The real production case: two 0.9.1 snapshots, 10.6 GB between them.
        let snapshots = vec![
            snapshot("0.9.1", "2026-07-31-22"),
            snapshot("0.9.1", "2026-08-02-19"),
        ];
        assert_eq!(
            pruned_names(snapshots, "/db/none"),
            vec![name("0.9.1", "2026-07-31-22")]
        );
    }

    #[test]
    fn never_prunes_the_snapshot_just_written() {
        let snapshots = vec![
            snapshot("0.9.2", "2026-08-03-09"),
            snapshot("0.9.1", "2026-08-02-19"),
            snapshot("0.9.0", "2026-07-01-08"),
            snapshot("0.8.0", "2026-06-01-08"),
        ];
        // 0.8.0 would normally be pruned; naming it as the fresh write protects it.
        let kept_name = name("0.8.0", "2026-06-01-08");
        let kept = format!("/db/{kept_name}");
        assert_eq!(
            pruned_names(snapshots, &kept),
            vec![name("0.9.0", "2026-07-01-08")]
        );
    }

    #[test]
    fn keeps_everything_when_there_are_no_more_than_two_versions() {
        let snapshots = vec![
            snapshot("0.9.1", "2026-08-02-19"),
            snapshot("0.9.0", "2026-07-01-08"),
        ];
        assert!(pruned_names(snapshots, "/db/none").is_empty());
        assert!(pruned_names(vec![], "/db/none").is_empty());
    }

    #[test]
    fn prune_removes_only_superseded_snapshots_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cadencr.db");
        let snapshots = [
            name("0.9.2", "2026-08-03-09"),
            name("0.9.1", "2026-08-02-19"),
            name("0.9.1", "2026-07-31-22"),
            name("0.8.0", "2026-06-01-08"),
        ];
        for candidate in ["cadencr.db".to_string(), "cadencr.db-wal".to_string()]
            .into_iter()
            .chain(snapshots.iter().cloned())
        {
            std::fs::write(dir.path().join(candidate), b"x").unwrap();
        }
        let fresh = dir.path().join(&snapshots[0]);

        assert_eq!(prune(&db_path, &fresh), 2);

        // Live database and its WAL are untouched; so are the two kept versions.
        for kept in [
            "cadencr.db",
            "cadencr.db-wal",
            snapshots[0].as_str(),
            snapshots[1].as_str(),
        ] {
            assert!(dir.path().join(kept).exists(), "{kept} should survive");
        }
        for gone in [&snapshots[2], &snapshots[3]] {
            assert!(!dir.path().join(gone).exists(), "{gone} should be pruned");
        }

        // Ambiguous legacy backups are never managed or deleted.
        let legacy = dir.path().join("0.7.0.2026-05-01-08.cadencr.backup.db");
        std::fs::write(&legacy, b"legacy").unwrap();
        assert_eq!(prune(&db_path, &fresh), 0);
        assert!(legacy.exists());
    }

    #[cfg(unix)]
    #[test]
    fn prune_never_follows_a_snapshot_shaped_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cadencr.db");
        std::fs::write(&db_path, b"live").unwrap();

        let target_name = name("0.1.0", "2026-01-01-00");
        let target = outside.path().join(&target_name);
        std::fs::write(&target, b"must survive").unwrap();
        let link = dir.path().join(&target_name);
        symlink(&target, &link).unwrap();

        let managed = [
            name("0.4.0", "2026-04-01-00"),
            name("0.3.0", "2026-03-01-00"),
            name("0.2.0", "2026-02-01-00"),
        ];
        for candidate in &managed {
            std::fs::write(dir.path().join(candidate), b"snapshot").unwrap();
        }
        let fresh = dir.path().join(&managed[0]);

        assert_eq!(prune(&db_path, &fresh), 1);
        assert_eq!(std::fs::read(&target).unwrap(), b"must survive");
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
    }
}
