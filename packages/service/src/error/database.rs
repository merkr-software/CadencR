//! Keep `sqlx::Error` typed on its way into `AppError`: a busy/locked database
//! is a retryable 503 and a uniqueness/foreign-key rejection — the write meets
//! data that already exists or is gone — a 409, distinct from the unexpected
//! failures that stay masked 500s. A NOT NULL or CHECK violation is a bug in the
//! write itself, so it stays an internal error with its telemetry. The driver
//! text (which can quote SQL, table and column names) only ever reaches the logs.

use sqlx::error::{DatabaseError, ErrorKind};

use super::AppError;

pub(super) const BUSY_PUBLIC_MESSAGE: &str = "The database is busy; please retry in a moment";
pub(super) const CONSTRAINT_PUBLIC_MESSAGE: &str = "The change conflicts with existing data";

// SQLite primary result codes (the low byte of the extended code sqlx reports).
const SQLITE_BUSY: i32 = 5;
const SQLITE_LOCKED: i32 = 6;

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    Busy,
    Constraint,
}

pub(super) fn from_sqlx(error: sqlx::Error) -> AppError {
    let detail = error.to_string();
    match classify(&error) {
        Some(Failure::Busy) => AppError::DatabaseBusy(detail),
        Some(Failure::Constraint) => AppError::ConstraintViolation(detail),
        None => AppError::DatabaseError(detail),
    }
}

fn classify(error: &sqlx::Error) -> Option<Failure> {
    match error {
        sqlx::Error::PoolTimedOut => Some(Failure::Busy),
        sqlx::Error::Database(database) => classify_database(database.as_ref()),
        _ => None,
    }
}

fn classify_database(error: &dyn DatabaseError) -> Option<Failure> {
    match error.kind() {
        ErrorKind::UniqueViolation | ErrorKind::ForeignKeyViolation => {
            return Some(Failure::Constraint)
        }
        ErrorKind::Other => {}
        // NOT NULL, CHECK, and any kind sqlx adds later: internal.
        _ => return None,
    }
    let primary = error.code()?.parse::<i32>().ok()? & 0xff;
    match primary {
        SQLITE_BUSY | SQLITE_LOCKED => Some(Failure::Busy),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use std::time::Duration;

    async fn memory_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE CHECK (name <> ''))",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO parent (id, name) VALUES (1, 'taken')")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn failing(pool: &SqlitePool, sql: &'static str) -> sqlx::Error {
        sqlx::query(sql).execute(pool).await.unwrap_err()
    }

    #[tokio::test]
    async fn uniqueness_rejections_are_conflicts() {
        let pool = memory_pool().await;
        for sql in [
            "INSERT INTO parent (id, name) VALUES (2, 'taken')",
            "INSERT INTO parent (id, name) VALUES (1, 'other')",
        ] {
            let error = from_sqlx(failing(&pool, sql).await);
            assert!(
                matches!(error, AppError::ConstraintViolation(_)),
                "{sql}: {error:?}"
            );
        }
    }

    #[tokio::test]
    async fn not_null_and_check_violations_stay_internal() {
        let pool = memory_pool().await;
        for sql in [
            "INSERT INTO parent (id, name) VALUES (3, NULL)",
            "INSERT INTO parent (id, name) VALUES (4, '')",
        ] {
            let error = from_sqlx(failing(&pool, sql).await);
            assert!(
                matches!(error, AppError::DatabaseError(_)),
                "{sql}: {error:?}"
            );
        }
    }

    #[tokio::test]
    async fn other_database_errors_stay_internal() {
        let pool = memory_pool().await;
        let error = from_sqlx(failing(&pool, "SELECT * FROM missing_table").await);
        assert!(matches!(error, AppError::DatabaseError(_)), "{error:?}");
        assert!(matches!(
            from_sqlx(sqlx::Error::RowNotFound),
            AppError::DatabaseError(_)
        ));
    }

    #[test]
    fn pool_timeout_is_busy() {
        assert!(matches!(
            from_sqlx(sqlx::Error::PoolTimedOut),
            AppError::DatabaseBusy(_)
        ));
    }

    #[tokio::test]
    async fn a_held_write_lock_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let options = SqliteConnectOptions::new()
            .filename(dir.path().join("busy.db"))
            .create_if_missing(true)
            .busy_timeout(Duration::ZERO);
        let holder = SqlitePool::connect_with(options.clone()).await.unwrap();
        sqlx::query("CREATE TABLE t (id INTEGER)")
            .execute(&holder)
            .await
            .unwrap();
        let mut lock = holder.begin().await.unwrap();
        sqlx::query("INSERT INTO t (id) VALUES (1)")
            .execute(&mut *lock)
            .await
            .unwrap();

        let contender = SqlitePool::connect_with(options).await.unwrap();
        let error = from_sqlx(failing(&contender, "INSERT INTO t (id) VALUES (2)").await);
        assert!(matches!(error, AppError::DatabaseBusy(_)), "{error:?}");
        lock.rollback().await.unwrap();
    }
}
