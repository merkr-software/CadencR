//! Process ownership lives outside transcripts and database backups. Files
//! are bound to the locked database, and survive even if its reader is gone.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::remote::secure_fs;
use crate::shared::process_table::{BootIdentity, SessionAnchor};
use crate::shared::{
    atomic_file::write_atomic_private, discard::cleanup, fs_durability::sync_directory,
};

mod reap;

#[derive(Clone)]
pub(super) struct Journal {
    directory: PathBuf,
    boot: BootIdentity,
    ready: Arc<tokio::sync::OnceCell<()>>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    anchor: SessionAnchor,
    peers_stopped: bool,
}

pub(super) struct Lease {
    pub(super) id: Uuid,
    pub(super) anchor: SessionAnchor,
}

impl Journal {
    pub(super) async fn open(database: &Path, database_key: &str) -> Result<Self> {
        Ok(Self::new(
            journal_directory(database, database_key)?,
            BootIdentity::current().await?,
        ))
    }

    #[cfg(test)]
    pub(super) fn for_boot(database: &Path, boot: BootIdentity) -> Result<Self> {
        let key = crate::domain::restart_continuations::database_key(database)?;
        Ok(Self::new(journal_directory(database, &key)?, boot))
    }

    fn new(directory: PathBuf, boot: BootIdentity) -> Self {
        Self {
            directory,
            boot,
            ready: Arc::default(),
        }
    }

    pub(super) async fn record(&self, leader: u32, anchor: u32) -> Result<Lease> {
        let proof = SessionAnchor::capture(self.boot.clone(), leader, anchor).await?;
        self.ready
            .get_or_try_init(|| self.prepare_directory())
            .await?;
        let id = Uuid::new_v4();
        let directory = self.directory.clone();
        let entry = Entry {
            anchor: proof.clone(),
            peers_stopped: false,
        };
        tokio::task::spawn_blocking(move || {
            let path = file(&directory, id);
            if let Err(error) = write_entry(&path, &entry) {
                // No permission to exec was sent. A write that failed after
                // rename may have left an unarmed record.
                match fs::remove_file(&path) {
                    Ok(()) => cleanup(
                        sync_directory(&directory),
                        "discard a refused process record",
                    ),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => {
                        tracing::warn!(%error, "could not discard a refused process record")
                    }
                }
                return Err(error);
            }
            Ok(())
        })
        .await??;
        Ok(Lease { id, anchor: proof })
    }

    async fn prepare_directory(&self) -> Result<()> {
        let directory = self.directory.clone();
        tokio::task::spawn_blocking(move || {
            let parent = directory
                .parent()
                .context("process journal has no parent directory")?;
            secure_fs::create_dir_owner_only(&directory)?;
            sync_directory(parent)?;
            Ok(())
        })
        .await?
    }

    pub(super) async fn finish(&self, id: Uuid) -> Result<()> {
        let path = file(&self.directory, id);
        let mut entry = read_entry(path.clone()).await?;
        if !entry.peers_stopped {
            if !entry.anchor.stop_peers(&self.boot).await? {
                return retire(path).await;
            }
            entry.peers_stopped = true;
            entry = persist_peers_stopped(path.clone(), entry).await?;
        } else {
            // Retry a previous write that may have renamed the completed
            // record before its directory sync failed.
            let directory = self.directory.clone();
            tokio::task::spawn_blocking(move || sync_directory(&directory)).await??;
        }
        entry.anchor.stop_anchor(&self.boot).await?;
        retire(path).await
    }
}

fn journal_directory(database: &Path, database_key: &str) -> Result<PathBuf> {
    let parent = database.parent().context("the database has no directory")?;
    Ok(parent.join(format!(".cadencr-processes-{database_key}")))
}

async fn persist_peers_stopped(path: PathBuf, entry: Entry) -> Result<Entry> {
    tokio::task::spawn_blocking(move || {
        write_entry(&path, &entry)?;
        Ok(entry)
    })
    .await?
}

fn file(directory: &Path, id: Uuid) -> PathBuf {
    directory.join(format!("{id}.json"))
}

async fn read_entry(path: PathBuf) -> Result<Entry> {
    tokio::task::spawn_blocking(move || {
        let mut text = String::new();
        secure_fs::open_owner_only_read(&path)?
            .take(2048)
            .read_to_string(&mut text)?;
        serde_json::from_str(&text)
            .with_context(|| format!("invalid process ownership record {}", path.display()))
    })
    .await?
}

fn write_entry(path: &Path, entry: &Entry) -> Result<()> {
    let text = serde_json::to_string(entry)?;
    write_atomic_private(path, &text).map_err(|error| anyhow::anyhow!("{error}"))
}

async fn retire(path: PathBuf) -> Result<()> {
    tokio::task::spawn_blocking(move || retire_file(&path, sync_directory)).await?
}

fn retire_file(path: &Path, sync: impl FnOnce(&Path) -> io::Result<()>) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    // The processes are already proven stopped. A deletion lost on reboot
    // only leaves a record whose ownership proof has expired.
    let dir = path.parent().context("process record has no directory")?;
    cleanup(sync(dir), "sync removal of the settled process record");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sync_failure_after_unlink_does_not_block_a_settled_drain() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settled.json");
        fs::write(&path, "fixture").unwrap();
        retire_file(&path, |_| {
            assert!(!path.exists());
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        })
        .unwrap();
        retire_file(&path, sync_directory).unwrap();
    }
}
