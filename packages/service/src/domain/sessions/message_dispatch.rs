use crate::error::AppError;

#[derive(Debug, PartialEq, Eq)]
pub enum DispatchClaim {
    Claimed { token: String },
    InProgress,
    Dispatched,
}

pub async fn claim(pool: &sqlx::SqlitePool, message_id: i64) -> Result<DispatchClaim, AppError> {
    let token = uuid::Uuid::new_v4().to_string();
    let claimed: Option<String> = sqlx::query_scalar(
        "UPDATE agent_message_dispatches
         SET status = 'dispatching', attempt_count = attempt_count + 1,
             claim_token = ?, claimed_at = datetime('now'), error = NULL,
             updated_at = datetime('now')
         WHERE message_id = ? AND status IN ('pending', 'error')
         RETURNING claim_token",
    )
    .bind(&token)
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    if claimed.is_some() {
        return Ok(DispatchClaim::Claimed { token });
    }
    dispatch_status(pool, message_id).await
}

async fn dispatch_status(
    pool: &sqlx::SqlitePool,
    message_id: i64,
) -> Result<DispatchClaim, AppError> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM agent_message_dispatches WHERE message_id = ?")
            .bind(message_id)
            .fetch_optional(pool)
            .await?;
    match status.as_deref() {
        Some("dispatching") => Ok(DispatchClaim::InProgress),
        Some("dispatched") => Ok(DispatchClaim::Dispatched),
        Some(other) => Err(AppError::Internal(format!(
            "message {message_id} has unclaimable dispatch status '{other}'"
        ))),
        None => Err(AppError::Internal(format!(
            "message {message_id} has no dispatch lifecycle"
        ))),
    }
}

pub async fn mark_succeeded(
    pool: &sqlx::SqlitePool,
    message_id: i64,
    token: &str,
) -> Result<(), AppError> {
    update_claim(pool, message_id, token, "dispatched", None).await
}

pub async fn mark_failed(
    pool: &sqlx::SqlitePool,
    message_id: i64,
    token: &str,
    error: &str,
) -> Result<(), AppError> {
    update_claim(pool, message_id, token, "error", Some(error)).await
}

async fn update_claim(
    pool: &sqlx::SqlitePool,
    message_id: i64,
    token: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    let result = sqlx::query(
        "UPDATE agent_message_dispatches
         SET status = ?, error = ?, claim_token = NULL, claimed_at = NULL,
             dispatched_at = CASE WHEN ? = 'dispatched' THEN datetime('now') ELSE NULL END,
             updated_at = datetime('now')
         WHERE message_id = ? AND status = 'dispatching' AND claim_token = ?",
    )
    .bind(status)
    .bind(error)
    .bind(status)
    .bind(message_id)
    .bind(token)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(AppError::Internal(format!(
            "dispatch claim for message {message_id} is no longer current"
        )));
    }
    Ok(())
}

pub async fn recover_orphaned_claims(pool: &sqlx::SqlitePool) -> anyhow::Result<u64> {
    let mut tx = pool.begin().await?;
    let mut recovered = sqlx::query(
        "UPDATE agent_message_dispatches
         SET status = 'error', error = 'service restarted during dispatch',
             claim_token = NULL, claimed_at = NULL, updated_at = datetime('now')
         WHERE status = 'dispatching'",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    recovered += sqlx::query(
        "UPDATE agent_session_message_queue
         SET status = 'error', error = 'service restarted during delivery',
             claim_token = NULL, claimed_at = NULL
         WHERE status = 'delivering'",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query(
        "UPDATE agent_messages SET delivery_state = 'delivery_unknown'
         WHERE delivery_state = 'pending_agent' AND EXISTS (
             SELECT 1 FROM agent_session_message_queue q
             WHERE q.target_session_id = agent_messages.session_id
               AND q.message_uuid = agent_messages.message_uuid
               AND q.status = 'error'
               AND q.error = 'service restarted during delivery'
         )",
    )
    .execute(&mut *tx)
    .await?;
    // A schedule claimed but never finished was never delivered, so releasing
    // the claim (rather than marking it failed) lets the next poll re-attempt
    // it. That is safe to redo: the message uuid is derived from the schedule
    // and the occurrence, so a redelivery reconciles with whatever the dead
    // process persisted instead of duplicating it, and the catch-up grace
    // decides whether the run is now too stale to send at all.
    recovered += sqlx::query(
        "UPDATE schedules
         SET claim_token = NULL, claimed_at = NULL, updated_at = datetime('now')
         WHERE claim_token IS NOT NULL",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    recovered += sqlx::query(
        "UPDATE agent_session_reply_waits
         SET status = CASE
                 WHEN EXISTS (
                     SELECT 1 FROM agent_messages m
                     WHERE m.session_id = agent_session_reply_waits.requester_session_id
                       AND m.message_uuid = agent_session_reply_waits.delivery_message_uuid
                       AND m.delivery_state = 'received_agent'
                       AND m.content LIKE '<cadencr-reply%status=\"failed\"%'
                 ) THEN 'failed'
                 WHEN EXISTS (
                     SELECT 1 FROM agent_messages m
                     WHERE m.session_id = agent_session_reply_waits.requester_session_id
                       AND m.message_uuid = agent_session_reply_waits.delivery_message_uuid
                       AND m.delivery_state = 'received_agent'
                 ) THEN 'delivered'
                 ELSE 'armed'
             END,
             error = CASE
                 WHEN EXISTS (
                     SELECT 1 FROM agent_messages m
                     WHERE m.session_id = agent_session_reply_waits.requester_session_id
                       AND m.message_uuid = agent_session_reply_waits.delivery_message_uuid
                       AND m.delivery_state = 'received_agent'
                 ) THEN NULL
                 ELSE 'service restarted during reply delivery; retry remains armed'
             END,
             delivery_claim_token = NULL, delivery_started_at = NULL
         WHERE delivery_claim_token IS NOT NULL",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query(
        "UPDATE agent_messages SET delivery_state = 'delivery_unknown'
         WHERE delivery_state = 'pending_agent' AND id IN (
             SELECT message_id FROM agent_message_dispatches WHERE status = 'error'
         )",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(recovered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    #[tokio::test]
    async fn restart_recovers_every_abandoned_external_dispatch_claim() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        seed(&pool).await;

        assert_eq!(recover_orphaned_claims(&pool).await.unwrap(), 5);
        assert_eq!(
            claim(&pool, 1).await.unwrap(),
            DispatchClaim::Claimed {
                token: sqlx::query_scalar(
                    "SELECT claim_token FROM agent_message_dispatches WHERE message_id = 1"
                )
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        );
        let state: String =
            sqlx::query_scalar("SELECT delivery_state FROM agent_messages WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(state, "delivery_unknown");
        // The schedule was claimed but never delivered: releasing the claim
        // (without touching next_run_at) is what lets the poll loop retry it.
        let schedule: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT claim_token, claimed_at, next_run_at FROM schedules WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(schedule.0, None);
        assert_eq!(schedule.1, None);
        assert!(schedule.2.is_some());
        let reply_wait: (String, Option<String>, String) = sqlx::query_as(
            "SELECT status, delivery_claim_token, error
             FROM agent_session_reply_waits WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            reply_wait,
            (
                "armed".into(),
                None,
                "service restarted during reply delivery; retry remains armed".into()
            )
        );
        let delivered_wait: (String, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT status, delivery_claim_token, error
             FROM agent_session_reply_waits WHERE id = 2",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(delivered_wait, ("delivered".into(), None, None));
    }

    async fn seed(pool: &sqlx::SqlitePool) {
        sqlx::query("INSERT INTO projects (id,name,path) VALUES (1,'p','/tmp/p')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id,project_id,title,status,type) VALUES (1,1,'f','active','ws-session')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO agent_sessions (id,feature_id,agent_type,status) VALUES (1,1,'session','paused')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO agent_messages (id,session_id,role,content,message_type,message_uuid,delivery_state) VALUES (1,1,'user','x','user_message','00000000-0000-0000-0000-000000000001','pending_agent'), (2,1,'user','<cadencr-reply status=\"completed\">ok</cadencr-reply>','user_message','00000000-0000-0000-0000-000000000002','received_agent')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO agent_message_dispatches (message_id,status,claim_token) VALUES (1,'dispatching','a')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO agent_session_message_queue (target_session_id,content,status,claim_token) VALUES (1,'q','delivering','b')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO schedules (id,feature_id,prompt,target_kind,recurrence_kind,timezone,next_run_at,claim_token,claimed_at) VALUES (1,1,'s','conversation','once','UTC',datetime('now'),'c',datetime('now'))").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO agent_session_reply_waits (id,requester_session_id,responder_session_id,kind,status,delivery_claim_token,delivery_started_at,delivery_message_uuid) VALUES (1,1,1,'message','armed','d',datetime('now'),'00000000-0000-0000-0000-000000000001'), (2,1,1,'message','armed','e',datetime('now'),'00000000-0000-0000-0000-000000000002')").execute(pool).await.unwrap();
    }
}
