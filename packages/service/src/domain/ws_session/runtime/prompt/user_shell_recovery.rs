//! Startup recovery for Cadencr-managed user shell transcripts and context claims.

use sqlx::{Row, SqlitePool};

use super::user_shell_payload::{ManagedShellPayload, ManagedShellStrategy};

pub async fn recover_user_shell_context(pool: &SqlitePool) -> Result<u64, String> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("Failed to begin user shell recovery: {error}"))?;
    let rows = sqlx::query(
        "SELECT id, session_id, content FROM agent_messages
         WHERE message_type = 'tool_call'
           AND tool_name = 'Bash'
           AND json_valid(content)
           AND json_extract(content, '$.__cadencr_user_shell.strategy') = ?
           AND (
             json_extract(content, '$.status') = 'running'
             OR json_extract(content, '$.__cadencr_user_shell.context_state') = 'claimed'
           )
         ORDER BY id",
    )
    .bind(ManagedShellStrategy::CadencrManaged.as_str())
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| format!("Failed to load user shell recovery rows: {error}"))?;

    let mut recovered = 0;
    for row in rows {
        let row_id: i64 = row.get("id");
        let session_id: i64 = row.get("session_id");
        let content: String = row.get("content");
        let mut payload: ManagedShellPayload = serde_json::from_str(&content)
            .map_err(|error| format!("Failed to decode user shell row {row_id}: {error}"))?;
        let delivery_received =
            delivery_was_received(&mut transaction, session_id, payload.claimed_delivery_id())
                .await?;
        if !payload.recover_after_restart(delivery_received) {
            continue;
        }
        let recovered_content = serde_json::to_string(&payload)
            .map_err(|error| format!("Failed to encode user shell row {row_id}: {error}"))?;
        sqlx::query("UPDATE agent_messages SET content = ? WHERE id = ?")
            .bind(recovered_content)
            .bind(row_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("Failed to recover user shell row {row_id}: {error}"))?;
        recovered += 1;
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit user shell recovery: {error}"))?;
    Ok(recovered)
}

async fn delivery_was_received(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    session_id: i64,
    delivery_id: Option<&str>,
) -> Result<bool, String> {
    let Some(delivery_id) = delivery_id else {
        return Ok(false);
    };
    sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM agent_messages
           WHERE session_id = ?
             AND message_uuid = ?
             AND delivery_state = 'received_agent'
         )",
    )
    .bind(session_id)
    .bind(delivery_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(|error| format!("Failed to inspect user shell delivery {delivery_id}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::runtime::prompt::user_shell_context::claim_pending_user_shell_context;
    use crate::domain::ws_session::runtime::prompt::user_shell_payload::ManagedShellPayload;
    use serde_json::{json, Value};
    use sqlx::sqlite::SqlitePoolOptions;
    use std::borrow::Cow;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY,
                session_id INTEGER NOT NULL,
                role TEXT,
                message_type TEXT NOT NULL,
                tool_name TEXT,
                content TEXT NOT NULL,
                message_uuid TEXT,
                delivery_state TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn completed_claimed(command: &str, delivery_id: &str) -> String {
        let mut payload = ManagedShellPayload::running(command, "/tmp/project");
        payload.finish(Some(0), None);
        let mut value = serde_json::to_value(payload).unwrap();
        value["__cadencr_user_shell"]["context_state"] = json!("claimed");
        value["__cadencr_user_shell"]["delivery_id"] = json!(delivery_id);
        value.to_string()
    }

    async fn insert_shell(pool: &SqlitePool, id: i64, content: &str) {
        sqlx::query(
            "INSERT INTO agent_messages
             (id, session_id, role, message_type, tool_name, content)
             VALUES (?, 42, 'assistant', 'tool_call', 'Bash', ?)",
        )
        .bind(id)
        .bind(content)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn load_content(pool: &SqlitePool, id: i64) -> Value {
        let content: String = sqlx::query_scalar("SELECT content FROM agent_messages WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap();
        serde_json::from_str(&content).unwrap()
    }

    #[tokio::test]
    async fn restart_recovers_managed_shells_without_touching_provider_bash() {
        let pool = test_pool().await;
        let running =
            serde_json::to_string(&ManagedShellPayload::running("watch", "/tmp")).unwrap();
        insert_shell(&pool, 1, &running).await;
        insert_shell(
            &pool,
            2,
            &completed_claimed("delivered", "prompt-delivered"),
        )
        .await;
        insert_shell(&pool, 4, &completed_claimed("retry", "prompt-pending")).await;
        let provider_content = r#"{"status":"running","command":"provider-owned"}"#;
        insert_shell(&pool, 6, provider_content).await;
        sqlx::query(
            "INSERT INTO agent_messages
             (id, session_id, role, message_type, content, message_uuid, delivery_state)
             VALUES (3, 42, 'user', 'user_message', 'sent', 'prompt-delivered', 'received_agent'),
                    (5, 42, 'user', 'user_message', 'pending', 'prompt-pending', 'pending_agent')",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(recover_user_shell_context(&pool).await.unwrap(), 3);

        let recovered_running = load_content(&pool, 1).await;
        assert_eq!(recovered_running["status"], "failed");
        assert_eq!(
            recovered_running["__cadencr_user_shell"]["context_state"],
            "pending"
        );
        assert!(recovered_running["output"]
            .as_str()
            .unwrap()
            .contains("Cadencr restarted"));
        let delivered = load_content(&pool, 2).await;
        assert_eq!(
            delivered["__cadencr_user_shell"]["context_state"],
            "delivered"
        );
        let retry = load_content(&pool, 4).await;
        assert_eq!(retry["__cadencr_user_shell"]["context_state"], "pending");
        assert!(retry["__cadencr_user_shell"].get("delivery_id").is_none());
        assert_eq!(
            load_content(&pool, 6).await,
            serde_json::from_str::<Value>(provider_content).unwrap()
        );

        let context = claim_pending_user_shell_context(&pool, 42, "next-prompt")
            .await
            .unwrap();
        let prompt = context.append_to_prompt(Cow::Borrowed("continue")).unwrap();
        assert!(prompt.contains("watch"));
        assert!(prompt.contains("retry"));
        assert!(!prompt.contains("delivered"));
        context.mark_delivered(&pool).await.unwrap();
        assert!(claim_pending_user_shell_context(&pool, 42, "later")
            .await
            .unwrap()
            .is_empty());
    }
}
