//! Shared database fixture for the recorder's tests, which are split across the
//! recorder and its attribution submodule and would otherwise each carry a copy.

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

pub(super) async fn pool_with_session(
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> (SqlitePool, i64) {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();

    sqlx::query("INSERT INTO projects (name, path) VALUES ('p', '/tmp/p')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO features (project_id, title) VALUES (1, 'test feature')")
        .execute(&pool)
        .await
        .unwrap();
    let session_id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_sessions
             (feature_id, agent_type, runtime_provider, model, thinking_effort)
         VALUES (1, 'session', ?, ?, ?) RETURNING id",
    )
    .bind(provider)
    .bind(model)
    .bind(effort)
    .fetch_one(&pool)
    .await
    .unwrap();

    (pool, session_id)
}

/// `record_*` spawns the write, so tests must let it land.
pub(super) async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}
