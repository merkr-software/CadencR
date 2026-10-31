//! Persist provider-neutral model, permission, and runtime selections.

use super::WsSessionPersistence;
use sqlx::SqlitePool;
use tracing::error;

#[bon::bon]
impl WsSessionPersistence {
    pub async fn update_runtime_overrides_static(
        pool: &SqlitePool,
        session_id: i64,
        overrides: &crate::domain::agents::adapter::RuntimeConfigOverrides,
    ) -> Result<(), sqlx::Error> {
        let json = serde_json::to_string(overrides).expect("runtime overrides serialize");
        sqlx::query("UPDATE agent_sessions SET runtime_overrides = ? WHERE id = ?")
            .bind(json)
            .bind(session_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Persist an override document together with the model it resolves to,
    /// so the model column never names the model the session switched away
    /// from. `None` (an inherited model nothing resolved) keeps the column.
    pub async fn update_runtime_overrides_and_model(
        pool: &SqlitePool,
        session_id: i64,
        overrides: &crate::domain::agents::adapter::RuntimeConfigOverrides,
        model: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let json = serde_json::to_string(overrides).expect("runtime overrides serialize");
        sqlx::query(
            "UPDATE agent_sessions SET runtime_overrides = ?, model = COALESCE(?, model) WHERE id = ?",
        )
        .bind(json)
        .bind(model)
        .bind(session_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn update_model_static(
        pool: &SqlitePool,
        session_id: i64,
        model: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE agent_sessions SET model = ? WHERE id = ?")
            .bind(model)
            .bind(session_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn update_profile_static(pool: &SqlitePool, session_id: i64, profile: &str) {
        if let Err(e) = sqlx::query("UPDATE agent_sessions SET profile = ? WHERE id = ?")
            .bind(profile)
            .bind(session_id)
            .execute(pool)
            .await
        {
            error!(error = %e, session_db_id = session_id, "failed to update profile");
        }
    }

    pub async fn update_permission_mode_static(pool: &SqlitePool, session_id: i64, mode: &str) {
        if let Err(e) = sqlx::query("UPDATE agent_sessions SET permission_mode = ? WHERE id = ?")
            .bind(mode)
            .bind(session_id)
            .execute(pool)
            .await
        {
            error!(error = %e, session_db_id = session_id, "failed to update permission_mode");
        }
    }

    pub async fn update_access_mode_static(
        pool: &SqlitePool,
        session_id: i64,
        mode: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE agent_sessions SET codex_permission_mode = ? WHERE id = ?")
            .bind(mode)
            .bind(session_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    #[builder]
    pub async fn update_runtime_selection_static(
        pool: &SqlitePool,
        session_id: i64,
        runtime_provider: &str,
        model: Option<&str>,
        clear_thinking_effort: bool,
    ) -> Result<(), sqlx::Error> {
        let sql = if clear_thinking_effort {
            "UPDATE agent_sessions SET runtime_provider = ?, model = ?, thinking_effort = NULL WHERE id = ?"
        } else {
            "UPDATE agent_sessions SET runtime_provider = ?, model = ? WHERE id = ?"
        };
        sqlx::query(sql)
            .bind(runtime_provider)
            .bind(model)
            .bind(session_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Persist (or clear) the conversation-level thinking effort. The per-model
    /// workspace default is updated separately by the caller — this function
    /// only owns the row column. Pass `None` to set NULL (the default cascades
    /// through the per-model workspace setting at next session.init).
    pub async fn update_thinking_effort_static(
        pool: &SqlitePool,
        session_id: i64,
        thinking_effort: Option<&str>,
    ) {
        if let Err(e) = sqlx::query("UPDATE agent_sessions SET thinking_effort = ? WHERE id = ?")
            .bind(thinking_effort)
            .bind(session_id)
            .execute(pool)
            .await
        {
            error!(error = %e, session_db_id = session_id, "failed to update thinking_effort");
        }
    }

    pub async fn update_fast_mode_static(
        pool: &SqlitePool,
        session_id: i64,
        enabled: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE agent_sessions SET fast_mode = ? WHERE id = ?")
            .bind(enabled)
            .bind(session_id)
            .execute(pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::session_state::session_state_tests::setup_test_db;
    use super::*;

    #[tokio::test]
    async fn runtime_selection_preserves_or_clears_effort_atomically() {
        let pool = setup_test_db().await;
        let mut persistence = WsSessionPersistence::new(pool.clone(), 1);
        let id = persistence
            .find_or_create_session(None, None)
            .await
            .unwrap();
        sqlx::query("UPDATE agent_sessions SET thinking_effort = 'high' WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();

        for (model, clear_effort, expected_effort) in [
            (Some("sonnet"), false, Some("high")),
            (Some(""), true, None),
            (None, false, None),
        ] {
            WsSessionPersistence::update_runtime_selection_static()
                .pool(&pool)
                .session_id(id)
                .runtime_provider("claude_code")
                .maybe_model(model)
                .clear_thinking_effort(clear_effort)
                .call()
                .await
                .unwrap();
            let stored: (String, Option<String>, Option<String>) = sqlx::query_as(
                "SELECT runtime_provider, model, thinking_effort FROM agent_sessions WHERE id = ?",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(stored.0, "claude_code");
            assert_eq!(stored.1.as_deref(), model);
            assert_eq!(stored.2.as_deref(), expected_effort);
        }
    }

    #[tokio::test]
    async fn test_update_model_static() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p
            .find_or_create_session(Some("sonnet"), None)
            .await
            .unwrap();

        WsSessionPersistence::update_model_static(&pool, id, "opus")
            .await
            .unwrap();

        let row: (String,) = sqlx::query_as("SELECT model FROM agent_sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, "opus");
    }

    #[tokio::test]
    async fn test_update_permission_mode_static() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, Some("plan")).await.unwrap();

        WsSessionPersistence::update_permission_mode_static(&pool, id, "acceptEdits").await;

        let row: (String,) =
            sqlx::query_as("SELECT permission_mode FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, "acceptEdits");
    }

    #[tokio::test]
    async fn test_update_thinking_effort_static_set_and_clear() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::update_thinking_effort_static(&pool, id, Some("high")).await;
        let row: (Option<String>,) =
            sqlx::query_as("SELECT thinking_effort FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0.as_deref(), Some("high"));

        WsSessionPersistence::update_thinking_effort_static(&pool, id, None).await;
        let row: (Option<String>,) =
            sqlx::query_as("SELECT thinking_effort FROM agent_sessions WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(row.0.is_none());
    }

    #[tokio::test]
    async fn test_update_fast_mode_static() {
        let pool = setup_test_db().await;
        let mut p = WsSessionPersistence::new(pool.clone(), 1);
        let id = p.find_or_create_session(None, None).await.unwrap();

        WsSessionPersistence::update_fast_mode_static(&pool, id, true)
            .await
            .unwrap();
        let enabled: bool = sqlx::query_scalar("SELECT fast_mode FROM agent_sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();

        assert!(enabled);
    }
}
