use crate::domain::session_status::PendingKind;

/// The session row as answering a gate left it, read in the statement that
/// cleared the gate so no turn start or end can slip in between.
pub(crate) struct ClearedGate {
    pub status: String,
    pub feature_id: i64,
    /// A gate raised meanwhile, which stays pending.
    pub remaining: Option<(PendingKind, String)>,
}

pub(super) async fn clear_answered_gate_preserving_replacement(
    pool: &sqlx::SqlitePool,
    db_session_id: i64,
    answered_request_id: &str,
) -> Result<bool, sqlx::Error> {
    let cleared = clear_answered_gate(pool, db_session_id, answered_request_id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    Ok(cleared.remaining.is_some())
}

/// Clear `answered_request_id`, keeping a gate raised meanwhile. `None` when
/// the session does not exist.
pub(crate) async fn clear_answered_gate(
    pool: &sqlx::SqlitePool,
    db_session_id: i64,
    answered_request_id: &str,
) -> Result<Option<ClearedGate>, sqlx::Error> {
    let row: Option<(String, i64, Option<String>, Option<String>)> = sqlx::query_as(
        "UPDATE agent_sessions SET \
            pending_permission = CASE \
                WHEN pending_permission IS NOT NULL \
                    AND json_valid(pending_permission) \
                    AND json_extract(pending_permission, '$.request_id') IS NOT NULL \
                    AND json_extract(pending_permission, '$.request_id') != ? \
                THEN pending_permission \
                ELSE NULL \
            END, \
            pending_questions = CASE \
                WHEN pending_questions IS NOT NULL \
                    AND json_valid(pending_questions) \
                    AND json_extract(pending_questions, '$.request_id') IS NOT NULL \
                    AND json_extract(pending_questions, '$.request_id') != ? \
                THEN pending_questions \
                ELSE NULL \
            END \
         WHERE id = ? \
         RETURNING status, feature_id, \
            json_extract(pending_permission, '$.request_id'), \
            json_extract(pending_questions, '$.request_id')",
    )
    .bind(answered_request_id)
    .bind(answered_request_id)
    .bind(db_session_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(status, feature_id, permission, question)| {
        let remaining = permission
            .map(|id| (PendingKind::Permission, id))
            .or_else(|| question.map(|id| (PendingKind::Question, id)));
        ClearedGate {
            status,
            feature_id,
            remaining,
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn answering_a_gate_preserves_newer_questions_and_permissions() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL DEFAULT 7, status TEXT NOT NULL DEFAULT 'completed', pending_permission TEXT, pending_questions TEXT)")
            .execute(&pool).await.unwrap();
        let old = json!({"request_id":"old"}).to_string();
        let new = json!({"request_id":"new"}).to_string();
        for (permission, question, expected_permission, expected_question) in [
            (None, Some(old.as_str()), None, None),
            (None, Some(new.as_str()), None, Some(new.as_str())),
            (
                Some(new.as_str()),
                Some(old.as_str()),
                Some(new.as_str()),
                None,
            ),
            (
                Some(old.as_str()),
                Some(new.as_str()),
                None,
                Some(new.as_str()),
            ),
            (Some("{}"), Some("{}"), None, None),
            (Some("invalid"), Some("invalid"), None, None),
        ] {
            sqlx::query("INSERT OR REPLACE INTO agent_sessions (id, pending_permission, pending_questions) VALUES (1, ?, ?)")
                .bind(permission)
                .bind(question)
                .execute(&pool)
                .await
                .unwrap();
            let remains = clear_answered_gate_preserving_replacement(&pool, 1, "old")
                .await
                .unwrap();
            assert_eq!(
                remains,
                expected_permission.is_some() || expected_question.is_some()
            );
            let (permission, question): (Option<String>, Option<String>) = sqlx::query_as(
                "SELECT pending_permission, pending_questions FROM agent_sessions WHERE id = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(permission.as_deref(), expected_permission);
            assert_eq!(question.as_deref(), expected_question);
        }
    }

    #[tokio::test]
    async fn clearing_reports_the_row_and_the_gate_that_stays() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, status TEXT NOT NULL, pending_permission TEXT, pending_questions TEXT)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO agent_sessions VALUES (1, 7, 'running', ?, ?)")
            .bind(json!({"request_id":"approval"}).to_string())
            .bind(json!({"request_id":"old"}).to_string())
            .execute(&pool)
            .await
            .unwrap();

        let cleared = clear_answered_gate(&pool, 1, "old").await.unwrap().unwrap();
        assert_eq!(
            (cleared.status.as_str(), cleared.feature_id),
            ("running", 7)
        );
        assert_eq!(
            cleared.remaining,
            Some((PendingKind::Permission, "approval".to_string()))
        );
        let cleared = clear_answered_gate(&pool, 1, "approval")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cleared.remaining, None);
        assert!(clear_answered_gate(&pool, 2, "old")
            .await
            .unwrap()
            .is_none());
    }
}
