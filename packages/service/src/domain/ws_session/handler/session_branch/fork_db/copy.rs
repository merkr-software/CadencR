/// Share the source worktree verbatim. Provisioning then short-circuits on the
/// existing path instead of attempting a second `git worktree add`.
///
/// `feature_branch` travels with it for the same reason `worktree_branch` does:
/// a fork works on the source's branch rather than getting its own, so without
/// it a forked worktree-free feature falls back to whatever the shared project
/// checkout has on HEAD.
pub(super) async fn copy_worktree_settings(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    new_feature_id: i64,
    source_feature_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO feature_settings (feature_id, key, value) \
         SELECT ?, key, value FROM feature_settings \
         WHERE feature_id = ? \
         AND (key LIKE 'worktree%' OR key = 'skip_worktree' OR key = ?)",
    )
    .bind(new_feature_id)
    .bind(source_feature_id)
    .bind(crate::domain::git::service::SETTING_FEATURE_BRANCH)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Mark the forked conversation's first message as session-generated from the
/// source feature, so the existing provenance badge renders "forked from …".
/// No-op when the fork keeps nothing (forking at the first message).
pub(super) async fn record_fork_lineage(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    new_session_id: i64,
    source_session_id: i64,
    source_feature_id: i64,
    source_message_id: i64,
) -> Result<(), sqlx::Error> {
    let first_message_id: Option<i64> =
        sqlx::query_scalar("SELECT MIN(id) FROM agent_messages WHERE session_id = ?")
            .bind(new_session_id)
            .fetch_one(&mut **tx)
            .await?;
    let Some(first_message_id) = first_message_id else {
        return Ok(());
    };

    sqlx::query(
        "INSERT INTO agent_message_origins \
            (message_id, origin_kind, source_session_id, source_feature_id, source_message_id, note) \
         VALUES (?, 'session_generated', ?, ?, ?, 'Forked conversation') \
         ON CONFLICT(message_id) DO NOTHING",
    )
    .bind(first_message_id)
    .bind(source_session_id)
    .bind(source_feature_id)
    .bind(source_message_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Carry the sub-agent registry facts of every carrier the fork kept, so its
/// sub-agent cards keep their status and configuration. Nothing runs in the
/// fork yet: a run still live in the source lands stopped.
pub(super) async fn copy_subagent_runs(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    new_session_id: i64,
    source_session_id: i64,
) -> Result<(), sqlx::Error> {
    let now = crate::domain::subagents::model::now_timestamp();
    sqlx::query(
        "INSERT INTO agent_subagent_runs \
            (session_id, tool_use_id, parent_tool_use_id, status, status_reason, agent_type, \
             agent_name, description, prompt, model, model_resolved, reasoning_effort, background, \
             child_session_id, duration_ms, total_tokens, tool_use_count, result_summary, \
             started_at, ended_at, updated_at) \
         SELECT ?, r.tool_use_id, r.parent_tool_use_id, \
             CASE WHEN r.status = 'running' THEN 'stopped' ELSE r.status END, \
             CASE WHEN r.status = 'running' THEN ? ELSE r.status_reason END, \
             r.agent_type, r.agent_name, r.description, r.prompt, r.model, r.model_resolved, \
             r.reasoning_effort, r.background, r.child_session_id, r.duration_ms, \
             r.total_tokens, r.tool_use_count, r.result_summary, r.started_at, \
             CASE WHEN r.status = 'running' THEN COALESCE(r.ended_at, ?) ELSE r.ended_at END, ? \
         FROM agent_subagent_runs r \
         WHERE r.session_id = ? AND EXISTS ( \
             SELECT 1 FROM agent_messages m \
             WHERE m.session_id = ? AND m.tool_use_id = r.tool_use_id) \
         ORDER BY r.id",
    )
    .bind(new_session_id)
    .bind(crate::domain::agents::adapter::stop_reason::RUNTIME_ENDED)
    .bind(&now)
    .bind(&now)
    .bind(source_session_id)
    .bind(new_session_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
