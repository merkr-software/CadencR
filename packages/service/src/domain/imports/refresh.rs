//! Append newer provider events into an existing Cadencr session.
//!
//! A user can start a session in Cadencr, continue it directly in the
//! provider's CLI (which appends to its own on-disk log), then return to
//! Cadencr — where the conversation is now stale. This module re-reads the
//! provider's current on-disk conversation (reusing the importer's loaders)
//! and appends every event newer than the newest message already stored for
//! the session, leaving the existing prefix untouched.
//!
//! The diff is timestamp-based: live rows are written with SQLite's
//! `datetime('now')` (`YYYY-MM-DD HH:MM:SS`) while provider logs use ISO8601
//! (`…T…Z`), so the two are *not* string-comparable — we parse both to
//! `DateTime<Utc>` and compare instants.

use chrono::{DateTime, NaiveDateTime, Timelike, Utc};
use sqlx::SqlitePool;

use crate::error::AppError;

use super::models::ImportProvider;
use super::persistence::insert_message;
use super::service::{load_provider_session, LoadedSession};
use super::types::ImportedConversation;

/// Result of a refresh: how many provider events were appended, which session
/// they landed in, and the message-id cursor just before the append.
#[derive(Debug, Clone, Copy)]
pub struct RefreshOutcome {
    pub added: u32,
    pub session_db_id: i64,
    pub cursor: i64,
}

#[derive(Debug)]
struct SessionRef {
    id: i64,
    provider: ImportProvider,
    runtime_session_id: String,
    project_path: String,
}

/// Append provider events newer than the newest stored message into the
/// feature's latest CLI-backed session.
///
/// The frontend addresses a conversation by `features.id` (its stable, always-
/// available key) — `agent_sessions.id` is derived/late on the client and not
/// reliable for live sessions — so we resolve the target session here from the
/// feature.
pub async fn refresh_feature_from_provider(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    feature_id: i64,
) -> Result<RefreshOutcome, AppError> {
    let session = resolve_feature_session(read_pool, feature_id).await?;

    let loaded = load_provider_session(
        session.provider,
        &session.project_path,
        &session.runtime_session_id,
    )
    .await?;
    let cursor = max_message_id(read_pool, session.id).await?;
    let conv = match loaded {
        LoadedSession::Found(conv) => conv,
        // No on-disk conversation yet (or it has no messages) — nothing to sync.
        LoadedSession::NotFound | LoadedSession::Empty => {
            return Ok(RefreshOutcome {
                added: 0,
                session_db_id: session.id,
                cursor,
            })
        }
    };

    let cutoff = latest_message_time(read_pool, session.id).await?;
    let added = append_new_messages(write_pool, session.id, &conv, cutoff).await?;
    Ok(RefreshOutcome {
        added,
        session_db_id: session.id,
        cursor,
    })
}

/// Highest `agent_messages.id` for a session (`0` when it has none) — the cursor
/// the client fetches `after` to pull exactly the rows this refresh appends.
async fn max_message_id(pool: &SqlitePool, session_id: i64) -> Result<i64, AppError> {
    let max: Option<i64> =
        sqlx::query_scalar("SELECT MAX(id) FROM agent_messages WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(pool)
            .await?;
    Ok(max.unwrap_or(0))
}

/// Resolve the feature's latest CLI-backed agent session — the one whose
/// conversation the user sees and continues in the CLI. Rejects features with
/// no syncable session, a running session, or an unknown provider.
async fn resolve_feature_session(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<SessionRef, AppError> {
    let row: Option<(i64, Option<String>, Option<String>, String, String)> = sqlx::query_as(
        "SELECT s.id, s.runtime_provider, s.runtime_session_id, s.status, p.path
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         JOIN projects p ON p.id = f.project_id
         WHERE s.feature_id = ?
           AND s.runtime_session_id IS NOT NULL
           AND s.runtime_session_id != ''
         ORDER BY s.id DESC
         LIMIT 1",
    )
    .bind(feature_id)
    .fetch_optional(pool)
    .await?;

    let (id, provider, runtime_session_id, status, project_path) = row.ok_or_else(|| {
        AppError::BadRequest("This conversation has no CLI-backed session to sync from yet.".into())
    })?;

    if status == "running" {
        return Err(AppError::BadRequest(
            "Can't sync while the agent is running. Pause it first.".into(),
        ));
    }

    let provider = provider
        .as_deref()
        .and_then(ImportProvider::from_id)
        .ok_or_else(|| {
            AppError::BadRequest("This provider doesn't support syncing from the CLI.".into())
        })?;

    let runtime_session_id = runtime_session_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest("This session has no provider session id to sync from.".into())
        })?;

    Ok(SessionRef {
        id,
        provider,
        runtime_session_id,
        project_path,
    })
}

/// Newest stored-message instant for a session, or `None` when the session has
/// no messages yet (in which case the whole conversation is appended).
///
/// A raw string `MAX()` is unreliable across our two formats (SQLite-naive
/// `YYYY-MM-DD HH:MM:SS` vs ISO8601 `…T…Z`, which sort differently), so we let
/// SQLite's `datetime()` normalize both to a comparable second-precision string
/// and `MAX` that — one value back instead of every row.
async fn latest_message_time(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<Option<DateTime<Utc>>, AppError> {
    let max: Option<String> = sqlx::query_scalar(
        "SELECT MAX(datetime(created_at)) FROM agent_messages WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?;
    Ok(max.as_deref().and_then(parse_timestamp))
}

async fn append_new_messages(
    write_pool: &SqlitePool,
    session_id: i64,
    conv: &ImportedConversation,
    cutoff: Option<DateTime<Utc>>,
) -> Result<u32, AppError> {
    // Compare at whole-second granularity: live rows are stored with SQLite's
    // second-precision `datetime('now')`, while provider logs carry sub-second
    // ISO timestamps. Without truncating, the provider's *twin* of the newest
    // stored message (e.g. `…48.828Z` vs the stored `…48`) reads as newer and
    // gets re-appended — duplicating the tail on every sync.
    let cutoff = cutoff.map(truncate_to_seconds);
    let mut tx = write_pool.begin().await?;
    let mut added = 0u32;
    for msg in conv.messages.iter() {
        // Only append events we can time-place strictly after the cutoff.
        let Some(ts) = msg.created_at.as_deref().and_then(parse_timestamp) else {
            continue;
        };
        if cutoff.is_some_and(|cutoff| truncate_to_seconds(ts) <= cutoff) {
            continue;
        }
        insert_message(&mut tx, session_id, msg, conv).await?;
        added += 1;
    }
    tx.commit().await?;
    Ok(added)
}

/// Drop sub-second precision so SQLite-naive (second) and ISO8601 (millisecond)
/// timestamps for the same event compare equal.
fn truncate_to_seconds(dt: DateTime<Utc>) -> DateTime<Utc> {
    dt.with_nanosecond(0).unwrap_or(dt)
}

/// Parse a stored or provider timestamp to a UTC instant. Handles ISO8601
/// (provider logs) and SQLite's naive `datetime('now')` format (live rows,
/// treated as UTC). Returns `None` for anything we can't place.
fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc));
    }
    NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|naive| DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::imports::types::ImportedMessage;
    use sqlx::sqlite::SqlitePoolOptions;

    fn msg(ts: &str) -> ImportedMessage {
        ImportedMessage {
            role: "assistant".into(),
            content: format!("at {ts}"),
            message_type: "text".into(),
            tool_name: None,
            tool_use_id: None,
            model: Some("claude".into()),
            created_at: Some(ts.into()),
        }
    }

    fn conv_with(timestamps: &[&str]) -> ImportedConversation {
        ImportedConversation {
            source_session_id: "s".into(),
            title: "t".into(),
            model: Some("claude".into()),
            started_at: None,
            modified_at: None,
            messages: timestamps.iter().map(|ts| msg(ts)).collect(),
        }
    }

    async fn pool_with_messages(stored: &[&str]) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'text', tool_name TEXT, tool_use_id TEXT, parent_tool_use_id TEXT, model TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))")
            .execute(&pool)
            .await
            .unwrap();
        for ts in stored {
            sqlx::query(
                "INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (1, 'user', 'x', ?)",
            )
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }
        pool
    }

    #[test]
    fn parse_timestamp_handles_both_formats() {
        let iso = parse_timestamp("2026-05-27T19:56:38.828Z").unwrap();
        let sqlite = parse_timestamp("2026-05-27 19:56:38").unwrap();
        // The SQLite-naive value is the earlier instant despite sorting later
        // as a raw string ('T' > ' '), which is exactly why we parse.
        assert!(sqlite < iso);
        assert!(parse_timestamp("not a date").is_none());
    }

    #[tokio::test]
    async fn appends_only_messages_newer_than_cutoff() {
        // Stored conversation ends at 12:00:05 (SQLite-naive / UTC).
        let pool = pool_with_messages(&["2026-05-27 12:00:00", "2026-05-27 12:00:05"]).await;
        let cutoff = latest_message_time(&pool, 1).await.unwrap();

        // Provider log re-states the existing tail (ISO twin of 12:00:05) plus
        // two genuinely-newer CLI events.
        let conv = conv_with(&[
            "2026-05-27T12:00:05.000Z",
            "2026-05-27T12:01:00.000Z",
            "2026-05-27T12:02:00.000Z",
        ]);
        let added = append_new_messages(&pool, 1, &conv, cutoff).await.unwrap();
        assert_eq!(added, 2);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 4);
    }

    #[tokio::test]
    async fn subsecond_twin_of_stored_tail_is_not_reappended() {
        // Live row stored at second precision; the provider log's twin of that
        // same event carries sub-second precision and would sort as "newer"
        // without truncation — the exact cause of duplicate-on-resync.
        let pool = pool_with_messages(&["2026-05-27 12:00:05"]).await;
        let cutoff = latest_message_time(&pool, 1).await.unwrap();

        let conv = conv_with(&["2026-05-27T12:00:05.828Z", "2026-05-27T12:00:30.000Z"]);
        let added = append_new_messages(&pool, 1, &conv, cutoff).await.unwrap();
        assert_eq!(added, 1, "only the genuinely-later event should append");
    }

    #[tokio::test]
    async fn appends_everything_when_session_empty() {
        let pool = pool_with_messages(&[]).await;
        let cutoff = latest_message_time(&pool, 1).await.unwrap();
        assert!(cutoff.is_none());

        let conv = conv_with(&["2026-05-27T12:00:00.000Z", "2026-05-27T12:01:00.000Z"]);
        let added = append_new_messages(&pool, 1, &conv, cutoff).await.unwrap();
        assert_eq!(added, 2);
    }

    async fn pool_with_sessions() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for ddl in [
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL)",
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL)",
            "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, runtime_provider TEXT, runtime_session_id TEXT, status TEXT NOT NULL)",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO projects (id, path) VALUES (5, '/repo')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id) VALUES (1779, 5)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn add_session(pool: &SqlitePool, id: i64, provider: &str, sid: &str, status: &str) {
        sqlx::query("INSERT INTO agent_sessions (id, feature_id, runtime_provider, runtime_session_id, status) VALUES (?, 1779, ?, ?, ?)")
            .bind(id).bind(provider).bind(sid).bind(status)
            .execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn resolves_latest_cli_backed_session_for_feature() {
        let pool = pool_with_sessions().await;
        add_session(&pool, 100, "claude_code", "uuid-old", "completed").await;
        add_session(&pool, 3290, "claude_code", "uuid-new", "paused").await;

        let session = resolve_feature_session(&pool, 1779).await.unwrap();
        assert_eq!(session.id, 3290);
        assert_eq!(session.runtime_session_id, "uuid-new");
        assert_eq!(session.project_path, "/repo");
    }

    #[tokio::test]
    async fn rejects_feature_without_cli_session() {
        let pool = pool_with_sessions().await;
        // Session exists but never bound a provider session id.
        add_session(&pool, 100, "claude_code", "", "paused").await;
        let err = resolve_feature_session(&pool, 1779).await.unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn rejects_running_session() {
        let pool = pool_with_sessions().await;
        add_session(&pool, 3290, "claude_code", "uuid-new", "running").await;
        let err = resolve_feature_session(&pool, 1779).await.unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn skips_messages_without_a_timestamp() {
        let pool = pool_with_messages(&["2026-05-27 12:00:00"]).await;
        let cutoff = latest_message_time(&pool, 1).await.unwrap();

        let mut conv = conv_with(&["2026-05-27T12:05:00.000Z"]);
        conv.messages.push(ImportedMessage {
            created_at: None,
            ..msg("ignored")
        });
        let added = append_new_messages(&pool, 1, &conv, cutoff).await.unwrap();
        assert_eq!(added, 1);
    }
}
