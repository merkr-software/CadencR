//! What a session's tokens are filed under: provider, model, thinking effort.

use sqlx::{Row, SqlitePool};
use tracing::warn;

use super::report_failure;
use crate::domain::usage_stats::models::UsageAttribution;

const SESSION_ATTRIBUTION_SQL: &str =
    "SELECT runtime_provider, model, thinking_effort FROM agent_sessions WHERE id = ?";

/// Take the attribution a turn's tokens should be filed under, at the moment the
/// turn produces its first provider event.
///
/// Streamed output accumulates across a whole turn, and the session row is
/// mutable while that turn runs: the user can switch model or thinking effort
/// mid-stream and it is persisted immediately. Resolving attribution at flush
/// time would then file a turn's output under a model that produced none of it,
/// and split it from its own prompt — so callers snapshot here, early, and pass
/// the snapshot to [`super::record_runtime_usage`].
pub async fn snapshot_attribution(pool: &SqlitePool, session_id: i64) -> Option<UsageAttribution> {
    resolve_session_attribution(pool, session_id).await
}

/// Resolve what a session's tokens should be attributed to. `None` when the row
/// is gone or has no provider yet — there is nothing meaningful to chart.
pub(super) async fn resolve_session_attribution(
    pool: &SqlitePool,
    session_id: i64,
) -> Option<UsageAttribution> {
    match session_attribution(pool, session_id).await {
        Ok(Some(attribution)) => Some(attribution),
        Ok(None) => {
            warn!(
                session_id,
                "skipped usage stats: session row is gone or has no runtime provider"
            );
            None
        }
        Err(error) => {
            report_failure(&error, "failed to resolve usage stats attribution");
            None
        }
    }
}

async fn session_attribution(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<Option<UsageAttribution>, sqlx::Error> {
    let Some(row) = sqlx::query(SESSION_ATTRIBUTION_SQL)
        .bind(session_id)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };

    let provider_id: Option<String> = row.try_get("runtime_provider")?;
    let Some(provider_id) = provider_id.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    Ok(Some(UsageAttribution {
        provider_id,
        model_id: row
            .try_get::<Option<String>, _>("model")?
            .unwrap_or_default(),
        thinking_effort: row
            .try_get::<Option<String>, _>("thinking_effort")?
            .unwrap_or_default(),
    }))
}

#[cfg(test)]
pub(super) async fn pool_with_session(
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> (SqlitePool, i64) {
    use sqlx::sqlite::SqlitePoolOptions;

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();

    sqlx::query("INSERT INTO projects (name, path) VALUES ('p', '/tmp/p')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO features (project_id, title) VALUES (1, 'test feature')")
        .execute(&pool)
        .await
        .unwrap();
    let session_id = sqlx::query_scalar(
        "INSERT INTO agent_sessions
             (feature_id, agent_type, runtime_provider, model, thinking_effort)
         VALUES (1, 'session', ?, ?, ?) RETURNING id",
    )
    .bind(provider)
    .bind(model)
    .bind(effort)
    .fetch_one(&pool)
    .await
    .unwrap();

    (pool, session_id)
}

#[cfg(test)]
mod tests {
    use super::{pool_with_session, resolve_session_attribution, snapshot_attribution};

    #[tokio::test]
    async fn reads_the_sessions_provider_model_and_effort() {
        let (pool, session_id) =
            pool_with_session(Some("claude_code"), Some("claude-opus-5"), Some("high")).await;

        let attribution = snapshot_attribution(&pool, session_id).await.unwrap();

        assert_eq!(attribution.provider_id, "claude_code");
        assert_eq!(attribution.model_id, "claude-opus-5");
        assert_eq!(attribution.thinking_effort, "high");
    }

    #[tokio::test]
    async fn missing_model_and_effort_become_empty_strings() {
        let (pool, session_id) = pool_with_session(Some("codex"), None, None).await;

        let attribution = snapshot_attribution(&pool, session_id).await.unwrap();

        assert_eq!(attribution.model_id, "");
        assert_eq!(attribution.thinking_effort, "");
    }

    #[tokio::test]
    async fn a_session_without_a_provider_has_nothing_to_attribute() {
        let (pool, session_id) = pool_with_session(None, None, None).await;

        assert!(snapshot_attribution(&pool, session_id).await.is_none());
    }

    #[tokio::test]
    async fn a_deleted_session_resolves_to_nothing_but_does_not_error() {
        let (pool, session_id) = pool_with_session(Some("cursor"), Some("auto"), None).await;
        sqlx::query("DELETE FROM agent_sessions WHERE id = ?")
            .bind(session_id)
            .execute(&pool)
            .await
            .unwrap();

        assert!(resolve_session_attribution(&pool, session_id)
            .await
            .is_none());
    }
}
