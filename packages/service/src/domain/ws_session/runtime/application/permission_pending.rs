pub(super) async fn clear_answered_gate_preserving_replacement(
    pool: &sqlx::SqlitePool,
    db_session_id: i64,
    answered_request_id: &str,
) -> Result<bool, sqlx::Error> {
    let remaining: bool = sqlx::query_scalar(
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
         RETURNING pending_permission IS NOT NULL OR pending_questions IS NOT NULL",
    )
    .bind(answered_request_id)
    .bind(answered_request_id)
    .bind(db_session_id)
    .fetch_one(pool)
    .await?;
    Ok(remaining)
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
        sqlx::query("CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, pending_permission TEXT, pending_questions TEXT)")
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
            sqlx::query("INSERT OR REPLACE INTO agent_sessions VALUES (1, ?, ?)")
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
}
