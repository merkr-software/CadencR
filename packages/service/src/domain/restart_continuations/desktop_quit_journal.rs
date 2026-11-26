//! A quit accepted after the packaged sidecar died cannot use its HTTP API.
//! Electron and the next service compete to rename the previous boot's slot.
//! The database lock serializes service starts. A successful quit rename wins
//! over recovery, and the epoch advances only before admitting new work.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use uuid::Uuid;

use crate::remote::secure_fs;
use crate::shared::{
    atomic_file, discard::cleanup, file_digest::sha256_hex, fs_durability::sync_directory,
};

mod cleanup;
pub(crate) use cleanup::finish_cold_quit;

pub(crate) struct DesktopQuitJournal {
    directory: PathBuf,
    database_key: String,
    previous: Option<(Uuid, Phase)>,
    next: Option<Uuid>,
}

#[derive(Clone, Copy)]
enum Phase {
    Preparing,
    Recovering,
    Quit,
}

impl Phase {
    fn slot_name(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Recovering => "recovering",
            Self::Quit => "quit",
        }
    }
}

impl DesktopQuitJournal {
    pub(crate) async fn claim(database: &Path, next: Option<Uuid>) -> Result<Self> {
        let database = database.to_owned();
        tokio::task::spawn_blocking(move || Self::claim_locked(&database, next)).await?
    }

    fn claim_locked(database: &Path, next: Option<Uuid>) -> Result<Self> {
        let directory = recovery_directory(database)?;
        let database_key = database_key(database)?;
        let previous = match read_epoch(&current_path(&directory, &database_key))? {
            Some(epoch) => Some((epoch, claim_previous(&directory, epoch)?)),
            None => None,
        };
        Ok(Self {
            directory,
            database_key,
            previous,
            next,
        })
    }

    pub(crate) fn stops_interrupted_work(&self) -> bool {
        matches!(self.previous, Some((_, Phase::Quit)))
    }

    pub(crate) fn database_key(&self) -> &str {
        &self.database_key
    }

    pub(crate) async fn advance(self) -> Result<()> {
        tokio::task::spawn_blocking(move || self.advance_locked()).await?
    }

    fn advance_locked(self) -> Result<()> {
        let current = current_path(&self.directory, &self.database_key);
        if let Some(epoch) = self.next {
            secure_fs::create_dir_owner_only(&self.directory)?;
            // Persist the directory's entry before using it for a quit.
            if let Some(root) = self.directory.parent() {
                sync_directory(root)?;
            }
            // Electron can select a quit as soon as the armed slot exists.
            // Publish the database binding before making that slot selectable.
            let preparing = slot(&self.directory, epoch, "preparing");
            write_private(&preparing, "")?;
            write_private(&current, &epoch.to_string())?;
            fs::rename(preparing, slot(&self.directory, epoch, "armed"))?;
            sync_directory(&self.directory)?;
        } else if self.previous.is_some() {
            fs::remove_file(current)?;
            sync_directory(&self.directory)?;
        }
        if let Some((epoch, phase)) = self.previous {
            // The new epoch is already durable. A leftover slot cannot be used.
            cleanup(
                fs::remove_file(slot(&self.directory, epoch, phase.slot_name())),
                "discard the consumed desktop recovery slot",
            );
        }
        Ok(())
    }
}

fn current_path(directory: &Path, database_key: &str) -> PathBuf {
    directory.join(format!("{database_key}.current"))
}

/// Alongside the database directory, outside the database and its backups.
fn recovery_directory(database: &Path) -> Result<PathBuf> {
    let parent = database.parent().context("the database has no directory")?;
    let directory = parent.parent().unwrap_or(parent).join("desktop-recovery");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) => {
            anyhow::ensure!(metadata.is_dir(), "invalid desktop recovery directory")
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).context("could not inspect the desktop recovery directory")
        }
    }
    Ok(directory)
}

pub(crate) fn database_key(database: &Path) -> io::Result<String> {
    let mut identity = database.as_os_str().as_encoded_bytes().to_vec();
    let metadata = fs::metadata(database)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        identity.push(0);
        identity.extend_from_slice(&metadata.ino().to_le_bytes());
    }
    if let Ok(created) = metadata.created().and_then(|time| {
        time.duration_since(std::time::UNIX_EPOCH)
            .map_err(io::Error::other)
    }) {
        identity.extend_from_slice(&created.as_nanos().to_le_bytes());
    }
    Ok(sha256_hex(&identity))
}

fn write_private(path: &Path, content: &str) -> Result<()> {
    atomic_file::write_atomic_private(path, content).map_err(|error| anyhow::anyhow!("{error}"))
}

fn read_epoch(path: &Path) -> Result<Option<Uuid>> {
    let file = match secure_fs::open_owner_only_read(path) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|e| e.kind() == io::ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let mut epoch = String::new();
    file.take(64).read_to_string(&mut epoch)?;
    Ok(Some(
        epoch.parse().context("invalid desktop recovery epoch")?,
    ))
}

fn slot(directory: &Path, epoch: Uuid, state: &str) -> PathBuf {
    directory.join(format!("{epoch}.{state}"))
}

fn claim_previous(directory: &Path, epoch: Uuid) -> Result<Phase> {
    let recovering = slot(directory, epoch, "recovering");
    let phase = match fs::rename(slot(directory, epoch, "armed"), &recovering) {
        Ok(()) => Phase::Recovering,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let quit = slot(directory, epoch, "quit");
            if quit.try_exists()? {
                Phase::Quit
            } else if recovering.try_exists()? {
                Phase::Recovering
            } else {
                // The manifest was published, but the service died before
                // arming the slot. Keep that evidence across failed starts.
                anyhow::ensure!(
                    slot(directory, epoch, "preparing").try_exists()?,
                    "Cadencr could not determine how the previous desktop service ended"
                );
                Phase::Preparing
            }
        }
        Err(error) => return Err(error).context("could not claim the previous desktop's recovery"),
    };
    sync_directory(directory)?;
    Ok(phase)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::restart_continuations::{capture, store};
    use crate::domain::schedules::repository::test_support::fixture;

    fn database(root: &Path, name: &str) -> PathBuf {
        let directory = root.join("database");
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join(name);
        fs::File::create(&file).unwrap();
        file
    }

    #[tokio::test]
    async fn a_startup_that_died_between_binding_and_arming_can_be_replaced() {
        let root = tempfile::tempdir().unwrap();
        let database = database(root.path(), "work.db");
        let first = Uuid::new_v4();
        let next = Uuid::new_v4();
        let initial = DesktopQuitJournal::claim(&database, Some(first))
            .await
            .unwrap();
        secure_fs::create_dir_owner_only(&initial.directory).unwrap();
        let preparing = slot(&initial.directory, first, "preparing");
        let current = current_path(&initial.directory, initial.database_key());
        write_private(&preparing, "").unwrap();
        write_private(&current, &first.to_string()).unwrap();
        assert!(!slot(&initial.directory, first, "armed").exists());

        let replacement = DesktopQuitJournal::claim(&database, Some(next))
            .await
            .unwrap();
        assert!(!replacement.stops_interrupted_work());
        // If this replacement dies in recovery, the old desktop can still
        // tell it never armed.
        drop(replacement);
        assert!(!slot(&initial.directory, first, "recovering").exists());
        assert!(preparing.is_file());

        let replacement = DesktopQuitJournal::claim(&database, Some(next))
            .await
            .unwrap();
        replacement.advance().await.unwrap();
        assert!(!preparing.exists());
        assert!(slot(&initial.directory, next, "armed").is_file());
        assert_eq!(read_epoch(&current).unwrap(), Some(next));
    }

    #[tokio::test]
    async fn replacing_the_database_at_the_same_path_does_not_transfer_a_quit() {
        let root = tempfile::tempdir().unwrap();
        let db = database(root.path(), "work.db");
        let epoch = Uuid::new_v4();
        let journal = DesktopQuitJournal::claim(&db, Some(epoch)).await.unwrap();
        let directory = journal.directory.clone();
        journal.advance().await.unwrap();
        fs::rename(
            slot(&directory, epoch, "armed"),
            slot(&directory, epoch, "quit"),
        )
        .unwrap();

        fs::rename(&db, db.with_extension("old")).unwrap();
        database(root.path(), "work.db");
        assert!(!DesktopQuitJournal::claim(&db, None)
            .await
            .unwrap()
            .stops_interrupted_work());
    }

    #[tokio::test]
    async fn a_quit_after_the_sidecar_crashes_survives_failed_capture_and_is_consumed_before_new_work(
    ) {
        let root = tempfile::tempdir().unwrap();
        let db = database(root.path(), "first.db");
        let other_db = database(root.path(), "other.db");
        let first = Uuid::new_v4();
        let next = Uuid::new_v4();
        let journal = DesktopQuitJournal::claim(&db, Some(first)).await.unwrap();
        let directory = journal.directory.clone();
        journal.advance().await.unwrap();
        fs::rename(
            slot(&directory, first, "armed"),
            slot(&directory, first, "quit"),
        )
        .unwrap();
        assert!(!DesktopQuitJournal::claim(&other_db, None)
            .await
            .unwrap()
            .stops_interrupted_work());

        let (pool, _, feature) = fixture().await;
        let stopped = store::tests::session(&pool, feature, "running").await;
        let background = store::tests::session(&pool, feature, "completed").await;
        super::super::record_background_work(&pool, background, Some(chrono::Utc::now()))
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TRIGGER reject_capture BEFORE INSERT ON restart_continuations BEGIN SELECT RAISE(ABORT, 'unavailable'); END;")
            .execute(&pool).await.unwrap();
        let attempt = DesktopQuitJournal::claim(&db, Some(next)).await.unwrap();
        assert!(attempt.stops_interrupted_work());
        assert!(capture::capture_left_behind_once_with_quit(
            &pool,
            attempt.stops_interrupted_work()
        )
        .await
        .is_err());
        drop(attempt);
        assert_eq!(
            store::session_status(&pool, stopped).await.unwrap(),
            "running"
        );
        sqlx::query("DROP TRIGGER reject_capture")
            .execute(&pool)
            .await
            .unwrap();

        let attempt = DesktopQuitJournal::claim(&db, Some(next)).await.unwrap();
        assert!(attempt.stops_interrupted_work());
        capture::capture_left_behind_once_with_quit(&pool, attempt.stops_interrupted_work())
            .await
            .unwrap();
        // A crash after commit, before advancing the journal, must retry the
        // same decision. Admission is still closed, so no new work is swept up.
        let duplicate = DesktopQuitJournal::claim(&db, Some(next)).await.unwrap();
        assert!(duplicate.stops_interrupted_work());
        capture::capture_left_behind_once_with_quit(&pool, duplicate.stops_interrupted_work())
            .await
            .unwrap();
        duplicate.advance().await.unwrap();

        let state = crate::app_state::AppState::with_pool(pool.clone());
        let report = super::super::startup::run(&state).await;
        assert_eq!(report.entries.len(), 2);
        assert!(report
            .entries
            .iter()
            .all(|entry| entry.reason.as_deref() == Some("stopped_on_quit")));
        let transcript: Vec<String> =
            sqlx::query_scalar("SELECT content FROM agent_messages ORDER BY session_id, id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(transcript, ["quit", "quit_background"]);
        assert!(super::super::startup::run(&state).await.entries.is_empty());

        let new_work = store::tests::session(&pool, feature, "running").await;
        let clean_start = DesktopQuitJournal::claim(&db, None).await.unwrap();
        assert!(!clean_start.stops_interrupted_work());
        capture::capture_left_behind_once_with_quit(&pool, clean_start.stops_interrupted_work())
            .await
            .unwrap();
        clean_start.advance().await.unwrap();
        let rows = store::list_pending(&pool).await.unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| (row.session_id, row.stop_requested()))
                .collect::<Vec<_>>(),
            [(new_work, false)]
        );
    }

    #[tokio::test]
    async fn a_start_that_won_the_slot_cannot_be_overridden_by_the_dead_desktop() {
        let root = tempfile::tempdir().unwrap();
        let db = database(root.path(), "database.db");
        let boot = Uuid::new_v4();
        let journal = DesktopQuitJournal::claim(&db, Some(boot)).await.unwrap();
        let directory = journal.directory.clone();
        journal.advance().await.unwrap();
        let lock = crate::startup_lock::acquire_db_lock(&db).unwrap();
        let recovering = DesktopQuitJournal::claim(&db, None).await.unwrap();
        assert!(crate::startup_lock::acquire_db_lock(&db).is_err());
        assert!(!recovering.stops_interrupted_work());
        assert_eq!(
            fs::rename(
                slot(&directory, boot, "armed"),
                slot(&directory, boot, "quit")
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::NotFound
        );
        recovering.advance().await.unwrap();
        drop(lock);
    }
}
