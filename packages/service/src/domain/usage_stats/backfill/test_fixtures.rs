//! Shared database fixtures for the import's tests.
//!
//! The scan, the ownership predicate and the orchestration all need the same
//! projects/features/sessions scaffolding, and each keeps its own tests beside
//! its own code — so the scaffolding lives here rather than being copied three
//! times.

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

pub(crate) async fn pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p');
         INSERT INTO features (id, project_id, title) VALUES (1, 1, 'f');",
    )
    .execute(&pool)
    .await
    .unwrap();
    pool
}

pub(crate) async fn session(pool: &SqlitePool, id: i64, provider: &str, model: &str, effort: &str) {
    sqlx::query(
        "INSERT INTO agent_sessions
             (id, feature_id, agent_type, runtime_provider, model, thinking_effort)
         VALUES (?, 1, 'session', ?, ?, ?)",
    )
    .bind(id)
    .bind(provider)
    .bind(model)
    .bind(effort)
    .execute(pool)
    .await
    .unwrap();
}

pub(crate) async fn message(
    pool: &SqlitePool,
    session_id: i64,
    role: &str,
    message_type: &str,
    content: &str,
    created_at: &str,
) {
    insert_message(
        pool,
        session_id,
        role,
        message_type,
        content,
        created_at,
        None,
    )
    .await;
}

/// A message stamped with the model that produced it, as assistant rows are.
pub(crate) async fn with_model(
    pool: &SqlitePool,
    session_id: i64,
    role: &str,
    message_type: &str,
    content: &str,
    created_at: &str,
    model: &str,
) {
    insert_message(
        pool,
        session_id,
        role,
        message_type,
        content,
        created_at,
        Some(model),
    )
    .await;
}

async fn insert_message(
    pool: &SqlitePool,
    session_id: i64,
    role: &str,
    message_type: &str,
    content: &str,
    created_at: &str,
    model: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO agent_messages
             (session_id, role, message_type, content, created_at, model)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(session_id)
    .bind(role)
    .bind(message_type)
    .bind(content)
    .bind(created_at)
    .bind(model)
    .execute(pool)
    .await
    .unwrap();
}

/// Today, in the same shape SQLite writes it, so imported rows land inside the
/// window `list_window` reads.
pub(crate) async fn today(pool: &SqlitePool) -> String {
    sqlx::query_scalar("SELECT strftime('%Y-%m-%d %H:%M:%S', 'now')")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// One prompt, optionally with a dispatch lifecycle row of `(status,
/// dispatched_at)`. Returns the message id.
pub(crate) async fn message_pool(dispatch: Option<(&str, Option<&str>)>) -> (SqlitePool, i64) {
    let pool = pool().await;
    session(&pool, 1, "claude_code", "opus", "high").await;
    let message_id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_messages (session_id, role, message_type, content)
         VALUES (1, 'user', 'user_message', 'one two three') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    if let Some((status, dispatched_at)) = dispatch {
        sqlx::query(
            "INSERT INTO agent_message_dispatches (message_id, status, dispatched_at)
             VALUES (?, ?, ?)",
        )
        .bind(message_id)
        .bind(status)
        .bind(dispatched_at)
        .execute(&pool)
        .await
        .unwrap();
    }
    (pool, message_id)
}

/// Stand in for an import that claimed `cutoff` at `claimed_at`.
pub(crate) async fn claim_at(pool: &SqlitePool, cutoff: i64, claimed_at: Option<&str>) {
    sqlx::query(
        "INSERT INTO provider_usage_backfill (id, version, cutoff_message_id, claimed_at)
         VALUES (1, 0, ?, ?)",
    )
    .bind(cutoff)
    .bind(claimed_at)
    .execute(pool)
    .await
    .unwrap();
}
