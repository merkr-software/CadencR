//! Clear a gate durably before the runtime hears its answer or its close.
//!
//! A gate whose clear is not saved comes back on the next open, while the
//! runtime that already moved on rejects any answer to it ("no open request").
//! So the clear goes first: when it fails, neither the runtime nor the request
//! is touched and the gate stays usable; when the runtime then refuses, the
//! gate is put back.

use sqlx::SqlitePool;

use crate::domain::ws_session::runtime::output::CommandError;

/// The stored form of the gate cleared ahead, to put back if the runtime
/// refuses. A column is `None` when it did not hold this request.
#[must_use = "restore the gate if the runtime refuses the answer or the close"]
pub(crate) struct GateClearedAhead {
    session_id: i64,
    permission: Option<String>,
    question: Option<String>,
}

impl GateClearedAhead {
    /// Whether the gate was still stored when it was cleared.
    pub(crate) fn cleared_any(&self) -> bool {
        self.permission.is_some() || self.question.is_some()
    }

    /// Put the gate back where it was cleared from, unless a newer gate has
    /// taken its column since.
    pub(crate) async fn restore(self, pool: &SqlitePool) -> Result<(), sqlx::Error> {
        if !self.cleared_any() {
            return Ok(());
        }
        sqlx::query(
            "UPDATE agent_sessions SET \
                pending_permission = COALESCE(pending_permission, ?), \
                pending_questions = COALESCE(pending_questions, ?) \
             WHERE id = ?",
        )
        .bind(self.permission)
        .bind(self.question)
        .bind(self.session_id)
        .execute(pool)
        .await?;
        Ok(())
    }
}

/// [`clear_gate_ahead`] for an answer: a failure is the command's error, and
/// the request stays open for another try.
pub(super) async fn clear_answered_gate_ahead(
    pool: &SqlitePool,
    session_id: i64,
    request_id: &str,
) -> Result<GateClearedAhead, CommandError> {
    clear_gate_ahead(pool, session_id, request_id)
        .await
        .map_err(|error| {
            CommandError::new(
                "DB_ERROR",
                format!("Failed to save the answer: {error}. The request stays open; try again."),
            )
        })
}

/// Put the gate back after the runtime refused the answer, so it can be
/// answered again; a gate that cannot be put back is named in the error.
pub(super) async fn restore_after_refusal<T>(
    pool: &SqlitePool,
    cleared: GateClearedAhead,
    result: Result<T, CommandError>,
) -> Result<T, CommandError> {
    let Err(mut error) = result else {
        return result;
    };
    if let Err(lost) = cleared.restore(pool).await {
        error.message = format!(
            "{}; the request could not be put back: {lost}",
            error.message
        );
    }
    Err(error)
}

/// Clear the stored gate naming `request_id`, keeping any other gate. Only
/// the exact value read is cleared, so a gate raised meanwhile survives.
pub(crate) async fn clear_gate_ahead(
    pool: &SqlitePool,
    session_id: i64,
    request_id: &str,
) -> Result<GateClearedAhead, sqlx::Error> {
    let stored: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT \
            CASE WHEN json_valid(pending_permission) \
                AND json_extract(pending_permission, '$.request_id') = ? \
                THEN pending_permission END, \
            CASE WHEN json_valid(pending_questions) \
                AND json_extract(pending_questions, '$.request_id') = ? \
                THEN pending_questions END \
         FROM agent_sessions WHERE id = ?",
    )
    .bind(request_id)
    .bind(request_id)
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    let (permission, question) = stored.unwrap_or((None, None));
    let cleared = GateClearedAhead {
        session_id,
        permission,
        question,
    };
    if cleared.cleared_any() {
        sqlx::query(
            "UPDATE agent_sessions SET \
                pending_permission = CASE WHEN pending_permission IS ? \
                    THEN NULL ELSE pending_permission END, \
                pending_questions = CASE WHEN pending_questions IS ? \
                    THEN NULL ELSE pending_questions END \
             WHERE id = ?",
        )
        // A column that did not hold the request binds NULL: `IS NULL` then
        // rewrites it unchanged.
        .bind(cleared.permission.as_deref())
        .bind(cleared.question.as_deref())
        .bind(session_id)
        .execute(pool)
        .await?;
    }
    Ok(cleared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, \
             pending_permission TEXT, pending_questions TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn stored(pool: &SqlitePool) -> (Option<String>, Option<String>) {
        sqlx::query_as("SELECT pending_permission, pending_questions FROM agent_sessions")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn clears_only_the_named_gate_and_restores_it() {
        let pool = pool().await;
        let question = json!({"request_id": "q-1"}).to_string();
        let other = json!({"request_id": "p-2"}).to_string();
        sqlx::query("INSERT INTO agent_sessions VALUES (1, ?, ?)")
            .bind(&other)
            .bind(&question)
            .execute(&pool)
            .await
            .unwrap();

        let cleared = clear_gate_ahead(&pool, 1, "q-1").await.unwrap();
        assert_eq!(stored(&pool).await, (Some(other.clone()), None));

        cleared.restore(&pool).await.unwrap();
        assert_eq!(stored(&pool).await, (Some(other), Some(question)));
    }

    #[tokio::test]
    async fn a_refused_clear_leaves_the_gate_stored() {
        let pool = pool().await;
        let question = json!({"request_id": "q-1"}).to_string();
        sqlx::query("INSERT INTO agent_sessions VALUES (1, NULL, ?)")
            .bind(&question)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER refuse BEFORE UPDATE OF pending_questions ON agent_sessions \
             BEGIN SELECT RAISE(FAIL, 'refused'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(clear_gate_ahead(&pool, 1, "q-1").await.is_err());
        assert_eq!(stored(&pool).await, (None, Some(question)));
    }

    #[tokio::test]
    async fn a_newer_gate_is_not_overwritten_by_a_restore() {
        let pool = pool().await;
        let old = json!({"request_id": "q-1"}).to_string();
        let newer = json!({"request_id": "q-2"}).to_string();
        sqlx::query("INSERT INTO agent_sessions VALUES (1, NULL, ?)")
            .bind(&old)
            .execute(&pool)
            .await
            .unwrap();
        let cleared = clear_gate_ahead(&pool, 1, "q-1").await.unwrap();
        sqlx::query("UPDATE agent_sessions SET pending_questions = ?")
            .bind(&newer)
            .execute(&pool)
            .await
            .unwrap();

        cleared.restore(&pool).await.unwrap();
        assert_eq!(stored(&pool).await, (None, Some(newer)));
    }
}
