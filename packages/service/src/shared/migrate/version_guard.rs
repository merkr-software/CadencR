use sqlx::SqlitePool;

use super::support::table_exists;

pub(super) async fn ensure_database_not_newer(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> anyhow::Result<()> {
    if !table_exists(pool, "_sqlx_migrations").await? {
        return Ok(());
    }

    let embedded_max = embedded_max_migration_version(migrator).unwrap_or(0);
    let db_max: Option<i64> =
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success = TRUE")
            .fetch_one(pool)
            .await?;

    if let Some(db_version) = db_max {
        if db_version > embedded_max {
            anyhow::bail!(
                "This database was updated by a newer version of Cadencr and cannot be opened safely by this older app. Install the latest Cadencr version, or restore a pre-migration backup before starting this older version. Database migration version: {db_version}; app supports up to: {embedded_max}."
            );
        }
    }

    Ok(())
}

fn embedded_max_migration_version(migrator: &sqlx::migrate::Migrator) -> Option<i64> {
    migrator.iter().map(|migration| migration.version).max()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    async fn memory_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true);
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap()
    }

    async fn file_pool(path: &str) -> SqlitePool {
        let options = SqliteConnectOptions::from_str(&format!("sqlite:{path}"))
            .unwrap()
            .create_if_missing(true);
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap()
    }

    async fn create_sqlx_migrations_table(pool: &SqlitePool) {
        sqlx::query(
            "CREATE TABLE _sqlx_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                checksum BLOB NOT NULL,
                execution_time BIGINT NOT NULL
            )",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_migration_row(pool: &SqlitePool, version: i64, success: bool) {
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, installed_on, success, checksum, execution_time)
             VALUES (?, 'future', CURRENT_TIMESTAMP, ?, x'00', 0)",
        )
        .bind(version)
        .bind(success)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn allows_database_without_sqlx_migration_table() {
        let pool = memory_pool().await;
        let migrator = sqlx::migrate!("./migrations");

        ensure_database_not_newer(&pool, &migrator).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_database_migrated_by_newer_app() {
        let pool = memory_pool().await;
        let migrator = sqlx::migrate!("./migrations");
        let future_version = embedded_max_migration_version(&migrator).unwrap() + 1;
        create_sqlx_migrations_table(&pool).await;
        insert_migration_row(&pool, future_version, true).await;

        let error = ensure_database_not_newer(&pool, &migrator)
            .await
            .unwrap_err()
            .to_string();

        assert!(
            error.contains("updated by a newer version of Cadencr"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("restore a pre-migration backup"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn run_migrations_rejects_newer_database_before_applying_changes() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_str().unwrap();
        let pool = file_pool(path).await;
        let migrator = sqlx::migrate!("./migrations");
        let future_version = embedded_max_migration_version(&migrator).unwrap() + 1;
        create_sqlx_migrations_table(&pool).await;
        insert_migration_row(&pool, future_version, true).await;

        let error = super::super::run_migrations(&super::super::MigrationContext::pool_only(&pool))
            .await
            .unwrap_err()
            .to_string();

        assert!(
            error.contains("cannot be opened safely by this older app"),
            "unexpected error: {error}"
        );
        assert!(
            !super::table_exists(&pool, "projects").await.unwrap(),
            "migration must stop before creating or mutating app tables"
        );
    }

    #[tokio::test]
    async fn ignores_failed_future_migration_rows() {
        let pool = memory_pool().await;
        let migrator = sqlx::migrate!("./migrations");
        let future_version = embedded_max_migration_version(&migrator).unwrap() + 1;
        create_sqlx_migrations_table(&pool).await;
        insert_migration_row(&pool, future_version, false).await;

        ensure_database_not_newer(&pool, &migrator).await.unwrap();
    }
}
