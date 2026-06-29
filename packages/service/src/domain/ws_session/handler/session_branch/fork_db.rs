//! Transactional DB surgery behind `branch.fork`: create the new feature that
//! shares the source worktree, copy the pre-cut conversation prefix into a new
//! session, and record the fork lineage — all in one transaction so a partial
//! fork can never surface. Kept separate from the WS handler so the handler
//! stays a thin orchestration layer.

/// What a fork produced: the new feature + session, plus the project they live
/// under (the originating client navigates to `project_id`/`new_feature_id`).
pub(super) struct ForkResult {
    pub new_feature_id: i64,
    pub new_session_id: i64,
    pub project_id: i64,
}

/// Create a new feature (same project) that shares the source feature's
/// worktree, a session under it carrying the pre-cut conversation + branched
/// runtime id, and the chosen message restored as the feature's composer draft.
/// All in one transaction so a partial fork can never surface.
pub(super) async fn create_forked_feature(
    pool: &sqlx::SqlitePool,
    source_session_id: i64,
    source_feature_id: i64,
    message_id: i64,
    draft_text: &str,
    new_runtime_session_id: Option<&str>,
) -> Result<ForkResult, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let (project_id, source_title): (i64, Option<String>) =
        sqlx::query_as("SELECT project_id, title FROM features WHERE id = ?")
            .bind(source_feature_id)
            .fetch_one(&mut *tx)
            .await?;
    let fork_title = match source_title {
        Some(title) if !title.trim().is_empty() => format!("{title} (fork)"),
        _ => "Fork".to_string(),
    };

    let new_feature_id = sqlx::query(
        "INSERT INTO features (project_id, title, status, type) VALUES (?, ?, 'active', 'ws-session')",
    )
    .bind(project_id)
    .bind(&fork_title)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();

    // Share the source worktree: copy its worktree settings verbatim so the new
    // feature resolves to the identical directory. The provisioning replay
    // short-circuits on the already-present path, so no `git worktree add` (which
    // would fail — the branch is already checked out) ever runs.
    sqlx::query(
        "INSERT INTO feature_settings (feature_id, key, value) \
         SELECT ?, key, value FROM feature_settings \
         WHERE feature_id = ? AND (key LIKE 'worktree%' OR key = 'skip_worktree')",
    )
    .bind(new_feature_id)
    .bind(source_feature_id)
    .execute(&mut *tx)
    .await?;

    // The composer restores its draft from `feature_settings.draft_prompt`, so
    // the chosen message must land there (not the session-scoped column) to show
    // up when the new feature opens.
    sqlx::query(
        "INSERT INTO feature_settings (feature_id, key, value) VALUES (?, 'draft_prompt', ?) \
         ON CONFLICT(feature_id, key) DO UPDATE SET value = excluded.value",
    )
    .bind(new_feature_id)
    .bind(draft_text)
    .execute(&mut *tx)
    .await?;

    // New session under the new feature, inheriting the source's provider/model
    // config but starting paused with the branched runtime session id.
    let new_session_id = sqlx::query(
        "INSERT INTO agent_sessions \
            (feature_id, agent_type, runtime_provider, runtime_session_id, status, \
             model, profile, permission_mode, codex_permission_mode, draft_prompt, started_at) \
         SELECT ?, agent_type, runtime_provider, ?, 'paused', \
             model, profile, permission_mode, codex_permission_mode, ?, datetime('now') \
         FROM agent_sessions WHERE id = ?",
    )
    .bind(new_feature_id)
    .bind(new_runtime_session_id)
    .bind(draft_text)
    .bind(source_session_id)
    .execute(&mut *tx)
    .await?
    .last_insert_rowid();

    // Copy messages [0, message_id) into the new session, preserving order.
    sqlx::query(
        "INSERT INTO agent_messages \
            (session_id, role, content, message_type, tool_name, tool_use_id, \
             parent_tool_use_id, model, provider_message_uuid, created_at) \
         SELECT ?, role, content, message_type, tool_name, tool_use_id, \
             parent_tool_use_id, model, provider_message_uuid, created_at \
         FROM agent_messages WHERE session_id = ? AND id < ? ORDER BY id",
    )
    .bind(new_session_id)
    .bind(source_session_id)
    .bind(message_id)
    .execute(&mut *tx)
    .await?;

    record_fork_lineage(
        &mut tx,
        new_session_id,
        source_session_id,
        source_feature_id,
        message_id,
    )
    .await?;

    tx.commit().await?;
    Ok(ForkResult {
        new_feature_id,
        new_session_id,
        project_id,
    })
}

/// Mark the forked conversation's first message as session-generated from the
/// source feature, so the existing provenance badge renders "forked from …".
/// No-op when the fork keeps nothing (forking at the first message).
async fn record_fork_lineage(
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn pool_with_source_feature() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE features (
                id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
                title TEXT, status TEXT, type TEXT);
             CREATE TABLE feature_settings (
                feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (feature_id, key));
             CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL,
                agent_type TEXT, runtime_provider TEXT, runtime_session_id TEXT,
                status TEXT, model TEXT, profile TEXT, permission_mode TEXT,
                codex_permission_mode TEXT DEFAULT 'default', draft_prompt TEXT,
                started_at TEXT);
             CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
                role TEXT, content TEXT, message_type TEXT, tool_name TEXT,
                tool_use_id TEXT, parent_tool_use_id TEXT, model TEXT,
                provider_message_uuid TEXT, created_at TEXT);
             CREATE TABLE agent_message_origins (
                message_id INTEGER PRIMARY KEY, origin_kind TEXT NOT NULL,
                source_session_id INTEGER, source_feature_id INTEGER,
                source_message_id INTEGER, note TEXT,
                created_at TEXT DEFAULT (datetime('now')));
             INSERT INTO features (id, project_id, title, status, type)
                VALUES (9, 3, 'My feature', 'active', 'ws-session');
             INSERT INTO feature_settings (feature_id, key, value) VALUES
                (9, 'worktree_path', '/tmp/wt'),
                (9, 'worktree_branch', 'feat/x'),
                (9, 'worktree_setup_step', 'ready'),
                (9, 'worktree_mode', 'new'),
                (9, 'unrelated_key', 'nope');
             INSERT INTO agent_sessions (id, feature_id, agent_type, runtime_provider, model, status)
                VALUES (1, 9, 'session', 'claude_code', 'opus', 'paused');
             INSERT INTO agent_messages (id, session_id, role, content, message_type) VALUES
                (1, 1, 'user', 'q1', 'user_message'),
                (2, 1, 'assistant', 'a1', 'text'),
                (3, 1, 'user', 'q2', 'user_message'),
                (4, 1, 'assistant', 'a2', 'text');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn create_forked_feature_shares_worktree_and_copies_prefix() {
        let pool = pool_with_source_feature().await;

        // Fork before message 3 → new feature + session keeping messages 1,2.
        let fork = create_forked_feature(&pool, 1, 9, 3, "q2", Some("forked-sid"))
            .await
            .unwrap();
        assert_ne!(fork.new_feature_id, 9);
        assert_ne!(fork.new_session_id, 1);
        assert_eq!(fork.project_id, 3);

        // New feature under the same project, titled "<source> (fork)".
        let (project_id, title): (i64, String) =
            sqlx::query_as("SELECT project_id, title FROM features WHERE id = ?")
                .bind(fork.new_feature_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(project_id, 3);
        assert_eq!(title, "My feature (fork)");

        // Worktree settings copied verbatim so it resolves to the same dir; the
        // unrelated setting is NOT dragged along.
        let settings: Vec<(String, String)> = sqlx::query_as(
            "SELECT key, value FROM feature_settings WHERE feature_id = ? ORDER BY key",
        )
        .bind(fork.new_feature_id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(settings
            .iter()
            .any(|(k, v)| k == "worktree_path" && v == "/tmp/wt"));
        assert!(settings
            .iter()
            .any(|(k, v)| k == "worktree_branch" && v == "feat/x"));
        assert!(settings.iter().any(|(k, _)| k == "worktree_setup_step"));
        assert!(!settings.iter().any(|(k, _)| k == "unrelated_key"));
        // The cut message is restored as the feature's composer draft.
        assert!(settings
            .iter()
            .any(|(k, v)| k == "draft_prompt" && v == "q2"));

        // New session under the new feature, branched runtime id + session draft.
        let (feature_id, provider, sid, draft): (i64, String, String, String) = sqlx::query_as(
            "SELECT feature_id, runtime_provider, runtime_session_id, draft_prompt \
             FROM agent_sessions WHERE id = ?",
        )
        .bind(fork.new_session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(feature_id, fork.new_feature_id);
        assert_eq!(provider, "claude_code");
        assert_eq!(sid, "forked-sid");
        assert_eq!(draft, "q2");

        // Only the pre-cut messages were copied, in order.
        let copied: Vec<(String, String)> = sqlx::query_as(
            "SELECT content, message_type FROM agent_messages WHERE session_id = ? ORDER BY id",
        )
        .bind(fork.new_session_id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(copied.len(), 2);
        assert_eq!(copied[0].0, "q1");
        assert_eq!(copied[1].0, "a1");

        // Source feature + session are untouched.
        let source_msgs: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(source_msgs, 4);
        let source_features: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM features WHERE id = 9")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(source_features, 1);

        // Lineage points back at the source feature + message.
        let (kind, src_feature, src_msg): (String, i64, i64) = sqlx::query_as(
            "SELECT origin_kind, source_feature_id, source_message_id FROM agent_message_origins \
             WHERE message_id = (SELECT MIN(id) FROM agent_messages WHERE session_id = ?)",
        )
        .bind(fork.new_session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(kind, "session_generated");
        assert_eq!(src_feature, 9);
        assert_eq!(src_msg, 3);
    }

    #[tokio::test]
    async fn fork_at_first_message_creates_empty_session_without_lineage() {
        let pool = pool_with_source_feature().await;
        let fork = create_forked_feature(&pool, 1, 9, 1, "q1", None)
            .await
            .unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = ?")
                .bind(fork.new_session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0, "nothing before the first message is copied");
        let origins: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_message_origins")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(origins, 0, "no lineage row when nothing was copied");
        // The new feature still gets the draft + shared worktree.
        let draft: Option<String> = sqlx::query_scalar(
            "SELECT value FROM feature_settings WHERE feature_id = ? AND key = 'draft_prompt'",
        )
        .bind(fork.new_feature_id)
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert_eq!(draft.as_deref(), Some("q1"));
    }
}
