/// A terminal state replaces only a pending (or untracked) one. A receipt may
/// also confirm a message that read as unknown or failed, except one whose
/// last dispatch failed: a Stop withdrew it, and until a retry dispatches it
/// again no agent can have received it.
pub async fn update_delivery_state(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    message_uuid: &str,
    state: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE agent_messages SET delivery_state = ?
         WHERE session_id = ? AND message_uuid = ?
           AND (delivery_state IS NULL OR delivery_state = 'pending_agent'
                OR (? = 'received_agent'
                    AND NOT (delivery_state = 'delivery_failed' AND EXISTS (
                        SELECT 1 FROM agent_message_dispatches d
                        WHERE d.message_id = agent_messages.id AND d.status = 'error'))))",
    )
    .bind(state)
    .bind(session_id)
    .bind(message_uuid)
    .bind(state)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// A retry dispatches a message that read as not delivered or unknown again.
pub async fn reopen_delivery(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    message_uuid: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE agent_messages SET delivery_state = 'pending_agent'
         WHERE session_id = ? AND message_uuid = ?
           AND delivery_state IN ('delivery_failed', 'delivery_unknown')",
    )
    .bind(session_id)
    .bind(message_uuid)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn resolve_pending_delivery_states(
    pool: &sqlx::SqlitePool,
    session_id: i64,
    state: &str,
) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        "UPDATE agent_messages SET delivery_state = ?
         WHERE session_id = ? AND delivery_state = 'pending_agent'",
    )
    .bind(state)
    .bind(session_id)
    .execute(pool)
    .await?
    .rows_affected())
}
