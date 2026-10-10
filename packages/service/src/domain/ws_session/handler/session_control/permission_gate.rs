pub(super) async fn clear_answered_gate_preserving_replacement(
    pool: &sqlx::SqlitePool,
    db_session_id: i64,
    answered_request_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE agent_sessions SET \
            pending_permission = CASE WHEN json_extract(pending_permission, '$.request_id') = ? \
                THEN NULL ELSE pending_permission END, \
            pending_questions = CASE WHEN json_extract(pending_questions, '$.request_id') = ? \
                THEN NULL ELSE pending_questions END \
         WHERE id = ?",
    )
    .bind(answered_request_id)
    .bind(answered_request_id)
    .bind(db_session_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn clears_only_the_answered_request_across_both_columns() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, pending_permission TEXT, pending_questions TEXT)")
            .execute(&pool).await.unwrap();
        sqlx::query(
            r#"INSERT INTO agent_sessions VALUES (1, '{"request_id":"a"}', '{"request_id":"b"}')"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        clear_answered_gate_preserving_replacement(&pool, 1, "a")
            .await
            .unwrap();
        let row: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT pending_permission, pending_questions FROM agent_sessions WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(row.0.is_none());
        assert_eq!(row.1.as_deref(), Some(r#"{"request_id":"b"}"#));
        clear_answered_gate_preserving_replacement(&pool, 1, "a")
            .await
            .unwrap();
        clear_answered_gate_preserving_replacement(&pool, 1, "b")
            .await
            .unwrap();
        let remaining: Option<String> =
            sqlx::query_scalar("SELECT pending_questions FROM agent_sessions WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(remaining.is_none());
    }
}
