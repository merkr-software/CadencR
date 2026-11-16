use sqlx::sqlite::SqlitePoolOptions;
use tempfile::TempDir;

#[tokio::test]
async fn test_wal_concurrent_access() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("coexist.db");
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    // Create schema via pool_a
    let pool_a = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&db_url)
        .await
        .unwrap();

    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(&pool_a)
        .await
        .unwrap();
    sqlx::query("PRAGMA busy_timeout=5000")
        .execute(&pool_a)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT)")
        .execute(&pool_a)
        .await
        .unwrap();

    // Open second pool
    let pool_b = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&db_url)
        .await
        .unwrap();
    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(&pool_b)
        .await
        .unwrap();
    sqlx::query("PRAGMA busy_timeout=5000")
        .execute(&pool_b)
        .await
        .unwrap();

    // Write from pool_a
    sqlx::query("INSERT INTO test_data (id, value) VALUES (1, 'hello')")
        .execute(&pool_a)
        .await
        .unwrap();

    // Immediately read from pool_b
    let row: (String,) = sqlx::query_as("SELECT value FROM test_data WHERE id = 1")
        .fetch_one(&pool_b)
        .await
        .unwrap();
    assert_eq!(row.0, "hello");

    // Write from pool_b
    sqlx::query("INSERT INTO test_data (id, value) VALUES (2, 'world')")
        .execute(&pool_b)
        .await
        .unwrap();

    // Read from pool_a
    let row: (String,) = sqlx::query_as("SELECT value FROM test_data WHERE id = 2")
        .fetch_one(&pool_a)
        .await
        .unwrap();
    assert_eq!(row.0, "world");

    // Verify total count from both pools
    let count_a: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM test_data")
        .fetch_one(&pool_a)
        .await
        .unwrap();
    let count_b: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM test_data")
        .fetch_one(&pool_b)
        .await
        .unwrap();
    assert_eq!(count_a.0, 2);
    assert_eq!(count_b.0, 2);
}
