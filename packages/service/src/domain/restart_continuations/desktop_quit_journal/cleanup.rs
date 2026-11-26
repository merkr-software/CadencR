//! Verify an accepted quit without starting the service. The quit slot stays
//! pending for normal startup to capture the interrupted conversations.

use std::future::Future;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use uuid::Uuid;

use super::{current_path, database_key, read_epoch, recovery_directory, slot, write_private};
#[cfg(any(target_os = "macos", target_os = "linux", test))]
use super::{DesktopQuitJournal, Phase};
use crate::remote::secure_fs;
use crate::startup_lock::{acquire_db_lock, DbLockGuard, StartupLockError};

pub(crate) async fn finish_cold_quit<F>(
    database: &Path,
    epoch: Uuid,
    reap: impl FnOnce(PathBuf, String) -> F,
) -> Result<()>
where
    F: Future<Output = Result<()>>,
{
    let database = database.to_owned();
    let Some(quit) =
        tokio::task::spawn_blocking(move || PendingQuit::begin(&database, epoch)).await??
    else {
        return Ok(());
    };
    reap(quit.lock.database().to_owned(), quit.database_key.clone()).await?;
    tokio::task::spawn_blocking(move || quit.confirm(epoch)).await?
}

struct PendingQuit {
    lock: DbLockGuard,
    database_key: String,
    receipt: PathBuf,
}

impl PendingQuit {
    fn begin(database: &Path, epoch: Uuid) -> Result<Option<Self>> {
        let database = std::fs::canonicalize(database)
            .context("could not locate the crashed service's database")?;
        let key = database_key(&database)?;
        let directory = recovery_directory(&database)?;
        let receipt = receipt_path(&directory, &key, epoch);
        // A racing startup may already have drained this exact epoch. A
        // receipt can acknowledge it without taking the new service's lock.
        if read_epoch(&receipt)? == Some(epoch) {
            return Ok(None);
        }

        let lock = match acquire_db_lock(&database) {
            Err(StartupLockError::WouldBlock { .. }) if read_epoch(&receipt)? == Some(epoch) => {
                return Ok(None);
            }
            result => result.context("could not lock the crashed service's database")?,
        };
        ensure_database_identity(lock.database(), &key)?;
        if read_epoch(&receipt)? == Some(epoch) {
            return Ok(None);
        }
        anyhow::ensure!(read_epoch(&current_path(&directory, &key))? == Some(epoch), "the interrupted desktop service is already being replaced. Try quitting again after recovery completes");
        secure_fs::open_owner_only_read(&slot(&directory, epoch, "quit"))
            .context("the interrupted service has no confirmed quit decision")?;
        Ok(Some(Self {
            lock,
            database_key: key,
            receipt,
        }))
    }

    fn confirm(self, epoch: Uuid) -> Result<()> {
        ensure_database_identity(self.lock.database(), &self.database_key)?;
        write_private(&self.receipt, &epoch.to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
impl DesktopQuitJournal {
    /// Record the OS observation before startup consumes the accepted quit.
    pub(crate) async fn confirm_processes_stopped(&self, database: &Path) -> Result<()> {
        if let Some((epoch, Phase::Quit)) = self.previous {
            let receipt = receipt_path(&self.directory, &self.database_key, epoch);
            let key = self.database_key.clone();
            let database = database.to_owned();
            tokio::task::spawn_blocking(move || {
                ensure_database_identity(&database, &key)?;
                // Claiming the quit already synced this directory, including
                // any receipt left by a previous cleanup.
                if read_epoch(&receipt)? != Some(epoch) {
                    write_private(&receipt, &epoch.to_string())?;
                }
                Ok::<(), anyhow::Error>(())
            })
            .await??;
        }
        Ok(())
    }
}

fn ensure_database_identity(database: &Path, key: &str) -> Result<()> {
    anyhow::ensure!(
        database_key(database)? == key,
        "the database was replaced during quit cleanup"
    );
    Ok(())
}

fn receipt_path(directory: &Path, database_key: &str, epoch: Uuid) -> PathBuf {
    // Retain each completed cold quit while it may still be awaiting an
    // acknowledgement from its desktop, even across later successful quits.
    directory.join(format!("{database_key}.{epoch}.stopped"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    async fn arm() -> (tempfile::TempDir, PathBuf, Uuid) {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("database");
        fs::create_dir(&directory).unwrap();
        let database = directory.join("work.db");
        fs::write(&database, b"placeholder").unwrap();
        let database = fs::canonicalize(database).unwrap();
        let epoch = Uuid::new_v4();
        let _lock = acquire_db_lock(&database).unwrap();
        DesktopQuitJournal::claim(&database, Some(epoch))
            .await
            .unwrap()
            .advance()
            .await
            .unwrap();
        (root, database, epoch)
    }

    #[tokio::test]
    async fn a_startup_that_won_the_quit_race_can_certify_only_the_epoch_it_drained() {
        let (_root, database, old) = arm().await;
        let directory = recovery_directory(&database).unwrap();
        fs::rename(
            slot(&directory, old, "armed"),
            slot(&directory, old, "quit"),
        )
        .unwrap();
        let lock = acquire_db_lock(&database).unwrap();
        let next = Uuid::new_v4();
        let startup = DesktopQuitJournal::claim(&database, Some(next))
            .await
            .unwrap();
        assert!(startup.stops_interrupted_work());
        let cleanup = || {
            finish_cold_quit(&database, old, |_, _| async {
                panic!("racing cleanup cannot drain new work")
            })
        };
        let error = cleanup().await.unwrap_err();
        assert!(format!("{error:#}").contains("another Cadencr service instance"));
        assert!(slot(&directory, old, "quit").is_file());

        startup.confirm_processes_stopped(&database).await.unwrap();
        startup.advance().await.unwrap();
        assert!(!slot(&directory, old, "quit").exists());
        cleanup().await.unwrap();

        fs::rename(
            slot(&directory, next, "armed"),
            slot(&directory, next, "quit"),
        )
        .unwrap();
        let later_startup = DesktopQuitJournal::claim(&database, Some(Uuid::new_v4()))
            .await
            .unwrap();
        later_startup
            .confirm_processes_stopped(&database)
            .await
            .unwrap();
        later_startup.advance().await.unwrap();
        cleanup().await.unwrap();

        drop(lock);
        let error = finish_cold_quit(&database, Uuid::new_v4(), |_, _| async {
            panic!("unexpected drain")
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("being replaced"));
    }

    #[tokio::test]
    async fn cleanup_cannot_convert_a_crash_only_recovery_to_a_quit() {
        let (_root, database, epoch) = arm().await;
        {
            let _lock = acquire_db_lock(&database).unwrap();
            let startup = DesktopQuitJournal::claim(&database, None).await.unwrap();
            assert!(!startup.stops_interrupted_work());
            startup.confirm_processes_stopped(&database).await.unwrap();
        }
        let error = finish_cold_quit(&database, epoch, |_, _| async {
            panic!("unexpected drain")
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("no confirmed quit decision"));
        assert!(slot(&recovery_directory(&database).unwrap(), epoch, "recovering").is_file());
    }

    #[tokio::test]
    async fn a_replacement_database_cannot_be_certified_using_its_predecessors_quit() {
        let (_root, database, epoch) = arm().await;
        let original_key = database_key(&database).unwrap();
        let directory = recovery_directory(&database).unwrap();
        let quit = slot(&directory, epoch, "quit");
        fs::rename(slot(&directory, epoch, "armed"), &quit).unwrap();

        let error = finish_cold_quit(&database, epoch, |locked_database, key| {
            assert_eq!(key, original_key);
            async move {
                fs::rename(&locked_database, locked_database.with_extension("previous")).unwrap();
                fs::write(&locked_database, b"replacement").unwrap();
                Ok(())
            }
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("database was replaced"));
        assert!(quit.is_file());
        assert!(!receipt_path(&directory, &original_key, epoch).exists());
    }
}
