use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::str::FromStr;

mod permissions;
use permissions::prepare_database;

#[derive(Debug)]
pub enum QuickCheckError {
    Query(sqlx::Error),
    Corrupt(Vec<String>),
}

impl std::fmt::Display for QuickCheckError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Query(error) => write!(formatter, "database quick_check could not run: {error}"),
            Self::Corrupt(rows) => {
                write!(
                    formatter,
                    "database quick_check failed: {}",
                    rows.join("; ")
                )
            }
        }
    }
}

impl std::error::Error for QuickCheckError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Query(error) => Some(error),
            Self::Corrupt(_) => None,
        }
    }
}

pub async fn run_quick_check(pool: &SqlitePool) -> Result<(), QuickCheckError> {
    let rows = sqlx::query_scalar::<_, String>("PRAGMA quick_check")
        .fetch_all(pool)
        .await
        .map_err(QuickCheckError::Query)?;
    validate_quick_check(rows)
}

fn validate_quick_check(rows: Vec<String>) -> Result<(), QuickCheckError> {
    if rows.len() == 1 && rows[0] == "ok" {
        Ok(())
    } else {
        Err(QuickCheckError::Corrupt(rows))
    }
}

/// Create a read-only SQLite pool (max 12 connections, query_only pragma).
pub async fn create_read_pool(db_path: &str) -> Result<SqlitePool, sqlx::Error> {
    prepare_database(db_path, false)
        .map_err(|error| sqlx::Error::Io(std::io::Error::other(format!("{error:#}"))))?;
    let options = SqliteConnectOptions::from_str(&format!("sqlite:{db_path}"))?
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_millis(5000))
        .pragma("journal_size_limit", "67108864")
        .pragma("query_only", "true")
        .read_only(true);

    SqlitePoolOptions::new()
        .max_connections(12)
        .connect_with(options)
        .await
}

/// Create a read-write SQLite pool (max 1 connection to serialize writes).
pub async fn create_write_pool(db_path: &str) -> Result<SqlitePool, sqlx::Error> {
    prepare_database(db_path, true)
        .map_err(|error| sqlx::Error::Io(std::io::Error::other(format!("{error:#}"))))?;
    let options = SqliteConnectOptions::from_str(&format!("sqlite:{db_path}"))?
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_millis(5000))
        .pragma("journal_size_limit", "67108864")
        // Preparation creates missing files exclusively with private permissions.
        // If the path disappears afterward, fail instead of recreating it here.
        .create_if_missing(false);

    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_pool_does_not_create_missing_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.db");
        assert!(create_read_pool(path.to_str().unwrap()).await.is_err());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn write_pool_still_supports_in_memory_databases() {
        let pool = create_write_pool(":memory:").await.unwrap();
        sqlx::query("CREATE TABLE entries (value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        run_quick_check(&pool).await.unwrap();
        pool.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sqlite_creates_private_wal_and_shm_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap().keep();
        let path = dir.as_path().join("new.db");
        let pool = create_write_pool(path.to_str().unwrap()).await.unwrap();
        sqlx::query("CREATE TABLE secrets (value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        for suffix in ["", "-wal", "-shm"] {
            let file = dir.as_path().join(format!("new.db{suffix}"));
            assert_eq!(
                std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        pool.close().await;
    }

    #[test]
    fn quick_check_reports_corruption_with_details() {
        let error = validate_quick_check(vec!["*** in database main ***".to_string()]).unwrap_err();

        assert!(matches!(error, QuickCheckError::Corrupt(_)));
        assert!(error.to_string().contains("quick_check failed"));
    }

    /// The anti-freeze contract between the pools: an open write transaction
    /// (a long maintenance batch, a migration step) must not stall readers,
    /// all read connections can be in use at once, and the read pool can never
    /// write.
    #[tokio::test]
    async fn readers_are_not_blocked_by_an_open_write_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("concurrent.db");
        let path = path.to_str().unwrap();
        let write_pool = create_write_pool(path).await.unwrap();
        sqlx::query("CREATE TABLE entries (value INTEGER)")
            .execute(&write_pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO entries VALUES (1)")
            .execute(&write_pool)
            .await
            .unwrap();
        let read_pool = create_read_pool(path).await.unwrap();
        // Readers only stay unblocked through a committing writer under WAL;
        // NORMAL sync is the write-latency trade-off WAL makes safe.
        for pool in [&write_pool, &read_pool] {
            let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
                .fetch_one(pool)
                .await
                .unwrap();
            assert_eq!(mode, "wal");
        }
        let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
            .fetch_one(&write_pool)
            .await
            .unwrap();
        assert_eq!(synchronous, 1, "write pool must use synchronous = NORMAL");

        let mut writer = write_pool.begin().await.unwrap();
        sqlx::query("INSERT INTO entries VALUES (2)")
            .execute(&mut *writer)
            .await
            .unwrap();

        // Every reader holds its connection until all of them hold one, so
        // this only finishes if the pool really serves them in parallel.
        let parallel = read_pool.options().get_max_connections() as usize;
        assert!(
            parallel > 4,
            "four readers starved the API under maintenance"
        );
        let all_connected = tokio::sync::Barrier::new(parallel);
        let readers = (0..parallel).map(|_| async {
            let mut conn = read_pool.acquire().await.unwrap();
            let seen: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entries")
                .fetch_one(&mut *conn)
                .await
                .unwrap();
            all_connected.wait().await;
            seen
        });
        let seen = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            futures::future::join_all(readers),
        )
        .await
        .expect("readers blocked behind the open write transaction");
        // Readers see the last commit, not the writer's pending row.
        assert!(seen.iter().all(|count| *count == 1), "{seen:?}");

        let refused = sqlx::query("INSERT INTO entries VALUES (3)")
            .execute(&read_pool)
            .await;
        assert!(refused.is_err(), "the read pool must not write");

        writer.commit().await.unwrap();
        read_pool.close().await;
        write_pool.close().await;
    }
}
