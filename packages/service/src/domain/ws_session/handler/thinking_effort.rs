use crate::domain::agents::{adapter_for_model, runtime_adapter};

pub(super) fn should_clear_for_model(
    runtime_provider: &str,
    model_id: &str,
    thinking_effort: Option<&str>,
) -> bool {
    let Some(effort) = thinking_effort else {
        return false;
    };

    adapter_for_model(model_id)
        .map(|(_, adapter)| adapter)
        .or_else(|| runtime_adapter(runtime_provider))
        .and_then(|adapter| adapter.supports_thinking_effort_level(model_id, effort))
        == Some(false)
}

pub(super) fn filter_for_model(
    runtime_provider: &str,
    model_id: Option<&str>,
    thinking_effort: Option<String>,
) -> (Option<String>, bool) {
    let Some(model_id) = model_id else {
        return (thinking_effort, false);
    };

    if !should_clear_for_model(runtime_provider, model_id, thinking_effort.as_deref()) {
        return (thinking_effort, false);
    }

    (None, true)
}

pub(super) async fn persist_runtime_provider(
    pool: &sqlx::SqlitePool,
    db_session_id: i64,
    runtime_provider: &str,
    clear_thinking_effort: bool,
) -> Result<(), sqlx::Error> {
    let sql = if clear_thinking_effort {
        "UPDATE agent_sessions SET runtime_provider = ?, thinking_effort = NULL WHERE id = ?"
    } else {
        "UPDATE agent_sessions SET runtime_provider = ? WHERE id = ?"
    };
    sqlx::query(sql)
        .bind(runtime_provider)
        .bind(db_session_id)
        .execute(pool)
        .await?;
    Ok(())
}
