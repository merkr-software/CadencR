//! Open, migrate and prepare the database before anything else touches it.

use std::path::Path;

use crate::config::Config;
use crate::domain::maintenance::database_compaction::{self, DatabaseCompactionError};
use crate::{dev_clone, dev_env, domain, shared};

pub(super) struct Pools {
    pub read: sqlx::SqlitePool,
    pub write: sqlx::SqlitePool,
}

pub(super) async fn prepare(config: &Config, db_path: &str) -> anyhow::Result<Pools> {
    // Freeze the data roots from Electron's launch env, then hydrate the
    // login-shell env before any git, agent or PTY subprocess spawns.
    shared::data_roots::pin_and_log(config.data_dir.as_deref())?;
    shared::login_env::hydrate_from_login_shell().await;

    let write_pool = shared::db::create_write_pool(db_path).await?;
    shared::migrate::run_migrations(&shared::migrate::MigrationContext {
        pool: &write_pool,
        db_path: dev_env::migration_backup_path(Path::new(db_path)),
        app_version: config.app_version.as_deref(),
    })
    .await?;
    // A fresh worktree clone first forgets the main checkout's live
    // agents, turns, schedules and queues, before recovery reads them.
    dev_clone::adopt_database(&write_pool, Path::new(db_path)).await?;
    prepare_blob_dir(db_path);
    compact_if_requested(&write_pool, db_path).await?;
    domain::usage_stats::history_import::run_once(&write_pool).await;
    let read_pool = shared::db::create_read_pool(db_path).await?;
    Ok(Pools {
        read: read_pool,
        write: write_pool,
    })
}

/// The one-time image backfill needs its destination before it can run.
/// Production uses `~/.cadencr/blobs`; an ad-hoc/dev database gets an
/// isolated directory named after that exact database.
fn prepare_blob_dir(db_path: &str) {
    let blob_dir = domain::blobs::dir::derive_from_db_path(db_path);
    if let Err(error) = domain::blobs::store::ensure_root(&blob_dir) {
        // Blob writes repeat the durable-directory check and fail open:
        // inline content stays in SQLite if storage is unavailable.
        tracing::warn!(dir = %blob_dir.display(), "failed to prepare blob dir: {error}");
    }
    domain::blobs::dir::init(blob_dir);
}

/// Reclaim pages requested by a completed background maintenance pass. An
/// incomplete initial optimization keeps the request set for a later startup
/// instead of delaying this one.
async fn compact_if_requested(write_pool: &sqlx::SqlitePool, db_path: &str) -> anyhow::Result<()> {
    match database_compaction::run_if_requested(write_pool, Path::new(db_path)).await {
        Ok(_) => Ok(()),
        Err(DatabaseCompactionError::Integrity(error)) => Err(anyhow::Error::new(error).context(
            "Database integrity verification failed. Cadencr stopped before accepting new writes. Restore a recent safety backup or contact support.",
        )),
        Err(DatabaseCompactionError::Operational(error)) => {
            // Compaction is an optimization, never a startup dependency. A
            // failed VACUUM leaves SQLite's original file intact and the
            // persisted request set so a later launch can retry safely.
            tracing::warn!("database compaction skipped: {error}");
            Ok(())
        }
    }
}
