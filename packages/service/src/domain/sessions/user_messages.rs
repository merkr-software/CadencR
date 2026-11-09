use sqlx::SqliteConnection;
use uuid::Uuid;

mod delivery;
mod models;

pub use delivery::{reopen_delivery, resolve_pending_delivery_states, update_delivery_state};
use models::CanonicalUserMessageRow;
pub use models::{NewUserMessage, PersistUserMessageError, PersistedUserMessage};

pub fn canonical_user_message_uuid(value: Option<&str>) -> Result<Uuid, uuid::Error> {
    value
        .map(Uuid::parse_str)
        .transpose()
        .map(|uuid| uuid.unwrap_or_else(Uuid::new_v4))
}

/// Insert one canonical user message or return the existing identical row.
///
/// The unique `(session_id, message_uuid)` index is the final concurrency
/// barrier: two transport deliveries can race this function, but only one can
/// report `inserted = true`. Reusing an identity with different content is a
/// hard conflict rather than silently changing or re-dispatching the message.
pub async fn persist_user_message(
    connection: &mut SqliteConnection,
    message: NewUserMessage<'_>,
) -> Result<PersistedUserMessage, PersistUserMessageError> {
    let message_uuid = message.message_uuid.to_string();
    let inserted = sqlx::query_as::<_, CanonicalUserMessageRow>(
        "INSERT INTO agent_messages
         (session_id, role, content, message_type, message_uuid, delivery_state, created_at)
         VALUES (?, 'user', ?, 'user_message', ?, ?, datetime('now'))
         ON CONFLICT(session_id, message_uuid) WHERE message_uuid IS NOT NULL DO NOTHING
         RETURNING id, message_uuid, content, created_at, delivery_state",
    )
    .bind(message.session_id)
    .bind(message.content)
    .bind(&message_uuid)
    .bind(message.delivery_state)
    .fetch_optional(&mut *connection)
    .await?;

    if let Some(row) = inserted {
        return Ok(row.into_persisted(true));
    }

    let existing = sqlx::query_as::<_, CanonicalUserMessageRow>(
        "SELECT id, message_uuid, content, created_at, delivery_state
         FROM agent_messages
         WHERE session_id = ? AND message_uuid = ?",
    )
    .bind(message.session_id)
    .bind(&message_uuid)
    .fetch_one(&mut *connection)
    .await?;
    if existing.content != message.content
        && !same_logical_content(&existing.content, message.content).await
    {
        return Err(PersistUserMessageError::IdentityConflict {
            session_id: message.session_id,
            message_uuid,
        });
    }
    Ok(existing.into_persisted(false))
}

/// Blob maintenance may replace an inline image body with its content-addressed
/// reference after the original send. A retry intentionally reuses the UUID
/// and reconstructs the inline body, so compare both forms after applying the
/// same lossless off-load transform before declaring an identity conflict.
async fn same_logical_content(existing: &str, incoming: &str) -> bool {
    let existing = existing.to_string();
    let incoming = incoming.to_string();
    tokio::task::spawn_blocking(move || {
        let existing_canonical = crate::domain::blobs::canonicalize_content(&existing)
            .unwrap_or_else(|| existing.to_string());
        let incoming_canonical = crate::domain::blobs::canonicalize_content(&incoming)
            .unwrap_or_else(|| incoming.to_string());
        existing_canonical == incoming_canonical
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::migrate::{run_migrations, MigrationContext};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    async fn setup() -> (sqlx::SqlitePool, i64) {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (1, 1, 'f', 'active', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let session_id = sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status)
             VALUES (1, 'session', 'paused') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        (pool, session_id)
    }

    #[tokio::test]
    async fn duplicate_identity_returns_one_row_and_one_insert_winner() {
        let (pool, session_id) = setup().await;
        let message_uuid = Uuid::new_v4();
        let mut connection = pool.acquire().await.unwrap();

        let first = persist_user_message(
            &mut connection,
            NewUserMessage {
                session_id,
                content: "hello",
                message_uuid,
                delivery_state: None,
            },
        )
        .await
        .unwrap();
        let retry = persist_user_message(
            &mut connection,
            NewUserMessage {
                session_id,
                content: "hello",
                message_uuid,
                delivery_state: None,
            },
        )
        .await
        .unwrap();

        assert!(first.inserted);
        assert!(!retry.inserted);
        assert_eq!(first.id, retry.id);
        drop(connection);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn concurrent_identity_race_has_exactly_one_insert_winner() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let options =
            SqliteConnectOptions::from_str(&format!("sqlite:{}", tmp.path().to_str().unwrap()))
                .unwrap()
                .create_if_missing(true)
                .busy_timeout(std::time::Duration::from_secs(2));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'f')")
            .execute(&pool)
            .await
            .unwrap();
        let session_id: i64 = sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status)
             VALUES (1, 'session', 'paused') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let message_uuid = Uuid::new_v4();
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));

        let attempt = |pool: sqlx::SqlitePool, barrier: std::sync::Arc<tokio::sync::Barrier>| {
            tokio::spawn(async move {
                let mut connection = pool.acquire().await.unwrap();
                barrier.wait().await;
                persist_user_message(
                    &mut connection,
                    NewUserMessage {
                        session_id,
                        content: "same logical send",
                        message_uuid,
                        delivery_state: Some("pending_agent"),
                    },
                )
                .await
                .unwrap()
            })
        };
        let (left, right) = tokio::join!(
            attempt(pool.clone(), barrier.clone()),
            attempt(pool.clone(), barrier)
        );
        let outcomes = [left.unwrap(), right.unwrap()];

        assert_eq!(
            outcomes.iter().filter(|message| message.inserted).count(),
            1
        );
        assert_eq!(outcomes[0].id, outcomes[1].id);
    }

    #[tokio::test]
    async fn duplicate_identity_with_different_content_is_rejected() {
        let (pool, session_id) = setup().await;
        let message_uuid = Uuid::new_v4();
        let mut connection = pool.acquire().await.unwrap();
        persist_user_message(
            &mut connection,
            NewUserMessage {
                session_id,
                content: "first",
                message_uuid,
                delivery_state: None,
            },
        )
        .await
        .unwrap();

        let error = persist_user_message(
            &mut connection,
            NewUserMessage {
                session_id,
                content: "different",
                message_uuid,
                delivery_state: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            PersistUserMessageError::IdentityConflict { .. }
        ));
    }

    #[tokio::test]
    async fn failed_image_message_retry_matches_after_blob_backfill() {
        use base64::Engine as _;

        let (pool, session_id) = setup().await;
        let message_uuid = Uuid::new_v4();
        let mut connection = pool.acquire().await.unwrap();
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend(std::iter::repeat_n(0xCD, 8_192));
        let payload = base64::engine::general_purpose::STANDARD.encode(bytes);
        let inline = serde_json::json!([{
            "type": "image",
            "source": { "type": "base64", "media_type": "image/png", "data": payload }
        }])
        .to_string();

        let first = persist_user_message(
            &mut connection,
            NewUserMessage {
                session_id,
                content: &inline,
                message_uuid,
                delivery_state: Some("delivery_failed"),
            },
        )
        .await
        .unwrap();
        let offloaded = crate::domain::blobs::offload_content(&inline).unwrap();
        sqlx::query("UPDATE agent_messages SET content = ? WHERE id = ?")
            .bind(&offloaded)
            .bind(first.id)
            .execute(&mut *connection)
            .await
            .unwrap();

        let retry = persist_user_message(
            &mut connection,
            NewUserMessage {
                session_id,
                content: &inline,
                message_uuid,
                delivery_state: Some("delivery_failed"),
            },
        )
        .await
        .unwrap();
        assert!(!retry.inserted);
        assert_eq!(retry.id, first.id);
        assert_eq!(retry.content, offloaded);
    }

    #[tokio::test]
    async fn terminal_delivery_update_reports_only_eligible_canonical_transitions() {
        let (pool, session_id) = setup().await;
        let message_uuid = Uuid::new_v4();
        let mut connection = pool.acquire().await.unwrap();
        persist_user_message(
            &mut connection,
            NewUserMessage {
                session_id,
                content: "tracked",
                message_uuid,
                delivery_state: Some("pending_agent"),
            },
        )
        .await
        .unwrap();
        drop(connection);

        assert!(!update_delivery_state(
            &pool,
            session_id,
            &Uuid::new_v4().to_string(),
            "delivery_failed"
        )
        .await
        .unwrap());
        assert!(update_delivery_state(
            &pool,
            session_id,
            &message_uuid.to_string(),
            "delivery_failed"
        )
        .await
        .unwrap());
        assert!(!update_delivery_state(
            &pool,
            session_id,
            &message_uuid.to_string(),
            "delivery_failed"
        )
        .await
        .unwrap());
    }
}
