//! Canonical prompt insertion and atomic dispatch-ledger creation.

use super::WsSessionPersistence;

impl WsSessionPersistence {
    /// Persist a canonical user prompt. A repeated UUID returns the existing
    /// row with `inserted = false`; callers must not dispatch that retry to the
    /// provider again.
    #[cfg(test)]
    pub async fn persist_user_message(
        &self,
        text: &str,
        message_uuid: uuid::Uuid,
    ) -> Result<
        crate::domain::sessions::user_messages::PersistedUserMessage,
        crate::domain::sessions::user_messages::PersistUserMessageError,
    > {
        self.persist_user_message_with_delivery(text, message_uuid, None)
            .await
    }

    pub async fn persist_user_message_with_delivery(
        &self,
        text: &str,
        message_uuid: uuid::Uuid,
        delivery_state: Option<&str>,
    ) -> Result<
        crate::domain::sessions::user_messages::PersistedUserMessage,
        crate::domain::sessions::user_messages::PersistUserMessageError,
    > {
        let session_id = self.session_db_id.ok_or(
            crate::domain::sessions::user_messages::PersistUserMessageError::MissingSessionId,
        )?;
        let mut connection = self.write_pool.acquire().await?;
        crate::domain::sessions::user_messages::persist_user_message(
            &mut connection,
            crate::domain::sessions::user_messages::NewUserMessage {
                session_id,
                content: text,
                message_uuid,
                delivery_state,
            },
        )
        .await
    }

    pub async fn persist_prompt_user_message(
        &self,
        text: &str,
        message_uuid: uuid::Uuid,
        delivery_state: Option<&str>,
    ) -> Result<
        crate::domain::sessions::user_messages::PersistedUserMessage,
        crate::domain::sessions::user_messages::PersistUserMessageError,
    > {
        let session_id = self.session_db_id.ok_or(
            crate::domain::sessions::user_messages::PersistUserMessageError::MissingSessionId,
        )?;
        let mut tx = self.write_pool.begin().await?;
        let message = crate::domain::sessions::user_messages::persist_user_message(
            &mut tx,
            crate::domain::sessions::user_messages::NewUserMessage {
                session_id,
                content: text,
                message_uuid,
                delivery_state,
            },
        )
        .await?;
        sqlx::query(
            "INSERT INTO agent_message_dispatches (message_id, status)
             VALUES (?, 'pending') ON CONFLICT(message_id) DO NOTHING",
        )
        .bind(message.id)
        .execute(&mut *tx)
        .await?;
        // Only the first delivery of a prompt counts: a retry reuses its UUID.
        if message.inserted {
            crate::domain::usage_stats::repository::count_user_message(&mut *tx, session_id)
                .await?;
        }
        tx.commit().await?;
        Ok(message)
    }
}

#[cfg(test)]
mod tests {
    use super::super::session_bootstrap::session_bootstrap_tests::setup_test_db;
    use super::WsSessionPersistence;

    #[tokio::test]
    async fn test_persist_user_message_uses_user_message_type() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        p.find_or_create_session(None, None).await;

        p.persist_user_message("Hello world", uuid::Uuid::new_v4())
            .await
            .unwrap();

        let row: (String, String, String) = sqlx::query_as(
            "SELECT role, content, message_type FROM agent_messages WHERE session_id = ?",
        )
        .bind(p.session_db_id.unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "user");
        assert_eq!(row.1, "Hello world");
        assert_eq!(row.2, "user_message");
    }

    #[tokio::test]
    async fn test_with_session_id_persists_user_message_without_find_or_create() {
        let pool = setup_test_db().await;
        let id: (i64,) = sqlx::query_as(
            "INSERT INTO agent_sessions (feature_id, agent_type, status) VALUES (1, 'session', 'running') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let p = WsSessionPersistence::with_session_id(pool.clone(), 1, Some(id.0));
        p.persist_user_message("hello from with_session_id", uuid::Uuid::new_v4())
            .await
            .unwrap();

        let row: (String,) =
            sqlx::query_as("SELECT content FROM agent_messages WHERE session_id = ?")
                .bind(id.0)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, "hello from with_session_id");
    }
}
