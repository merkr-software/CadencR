//! `get_feature_agent_state` — the main hydration query for the agent
//! workspace. Per-session message-fetching is delegated to
//! `feature_state_fetch`; block capping/trimming lives in `pagination`.
use super::super::models::*;
use super::blocks::build_blocks;
use super::feature_state_fetch::{
    fetch_full_messages, fetch_incremental_data, fetch_latest_todos, todo_fetch_session_ids,
    todos_from_full_messages, FullMessagesResult, IncrementalData,
};
use super::origins::attach_message_origins;
use super::pagination::{block_message_id, trim_blocks_to_cap, BLOCK_SOFT_CAP};
use crate::error::AppError;
use sqlx::SqlitePool;
use std::collections::HashMap;
pub async fn get_feature_agent_state(
    pool: &SqlitePool,
    feature_id: i64,
    after_message_ids: Option<HashMap<i64, i64>>,
    limit: Option<i64>,
    before_message_ids: Option<HashMap<i64, i64>>,
) -> Result<FeatureAgentStateResponse, AppError> {
    let sessions = sqlx::query_as::<_, AgentSessionRow>(
        r#"SELECT id, feature_id, agent_type, runtime_provider, runtime_session_id, status, started_at, ended_at,
           subprocess_id, model, profile, pending_questions, has_file_changes,
           permission_mode, codex_permission_mode, pending_permission,
           input_tokens, output_tokens, context_window, was_compacted, draft_prompt
           FROM agent_sessions WHERE feature_id = ? ORDER BY id ASC"#,
    )
    .bind(feature_id)
    .fetch_all(pool)
    .await?;
    if sessions.is_empty() {
        return Ok(FeatureAgentStateResponse { sessions: vec![] });
    }
    let after_map = after_message_ids.unwrap_or_default();
    let before_map = before_message_ids.unwrap_or_default();
    // Split sessions into full-fetch vs incremental
    let mut full_fetch_ids: Vec<i64> = Vec::new();
    let mut incremental_fetches: Vec<(i64, i64)> = Vec::new(); // (session_id, after_id)
    for s in &sessions {
        match after_map.get(&s.id).copied() {
            Some(after_id) if after_id > 0 => incremental_fetches.push((s.id, after_id)),
            _ => full_fetch_ids.push(s.id),
        }
    }
    // OpenCode HTTP-server hydration used to run here. Removed with the
    // removed long-lived transport: ACP sessions are subprocess-scoped and
    // there's no remote server to query for child-session messages once
    // the session ends. If parent/child relationships need to be
    // recovered post-shutdown for ACP, add a database-backed hydration
    // path here — do not bring back an HTTP fetch.
    let (full_result, incremental_result) = tokio::try_join!(
        fetch_full_messages(pool, &full_fetch_ids, limit, &before_map),
        fetch_incremental_data(pool, &incremental_fetches)
    )?;
    let FullMessagesResult {
        messages: mut full_messages,
        has_more: has_more_map,
        oldest_message_id: oldest_message_id_map,
    } = full_result;
    let IncrementalData {
        messages: mut incremental_messages,
        updated_tool_calls,
    } = incremental_result;
    attach_message_origins(pool, &mut full_messages).await?;
    attach_message_origins(pool, &mut incremental_messages).await?;
    let mut todos_by_session = if limit.is_none() && before_map.is_empty() {
        todos_from_full_messages(&full_messages)
    } else {
        HashMap::new()
    };
    let include_full_fetch_todos = limit.is_some() && before_map.is_empty();
    let todo_fetch_ids = todo_fetch_session_ids(
        &full_fetch_ids,
        include_full_fetch_todos,
        &incremental_messages,
        &updated_tool_calls,
    );
    todos_by_session.extend(fetch_latest_todos(pool, &todo_fetch_ids).await?);
    let session_states: Vec<SessionState> = sessions
        .into_iter()
        .map(|s| {
            // `remove` moves the Vec<AgentMessageRow> out — each sid is consumed
            // exactly once, so we save a per-session clone of every fetched row.
            let (is_incremental, msgs) = match incremental_messages.remove(&s.id) {
                Some(m) => (true, m),
                None => (false, full_messages.remove(&s.id).unwrap_or_default()),
            };
            build_session_state(
                s,
                msgs,
                is_incremental,
                &after_map,
                &updated_tool_calls,
                &mut todos_by_session,
                &has_more_map,
                &oldest_message_id_map,
            )
        })
        .collect();
    Ok(FeatureAgentStateResponse {
        sessions: session_states,
    })
}
#[allow(clippy::too_many_arguments)]
fn build_session_state(
    s: AgentSessionRow,
    msgs: Vec<AgentMessageRow>,
    is_incremental: bool,
    after_map: &HashMap<i64, i64>,
    updated_tool_calls: &HashMap<i64, HashMap<i64, String>>,
    todos_by_session: &mut HashMap<i64, Vec<serde_json::Value>>,
    has_more_map: &HashMap<i64, bool>,
    oldest_message_id_map: &HashMap<i64, i64>,
) -> SessionState {
    let max_message_id = if is_incremental {
        let new_max = msgs.iter().map(|m| m.id).max().unwrap_or(0);
        if new_max > 0 {
            new_max
        } else {
            after_map.get(&s.id).copied().unwrap_or(0)
        }
    } else {
        msgs.iter().map(|m| m.id).max().unwrap_or(0)
    };
    let mut blocks = build_blocks(&msgs);
    // Block-level pagination soft cap (full-fetch only). The
    // per-session message `limit` is on `agent_messages` rows, but
    // payload size scales with BLOCKS (every Bash call expands to two
    // blocks plus output). Drop the oldest root blocks until we are
    // under the cap and report has_more so the client can paginate.
    let mut trimmed_has_more = false;
    let mut trimmed_oldest_id: Option<i64> = None;
    if !is_incremental {
        let dropped = trim_blocks_to_cap(&mut blocks, BLOCK_SOFT_CAP);
        if dropped > 0 {
            trimmed_has_more = true;
            trimmed_oldest_id = blocks.iter().filter_map(block_message_id).min();
        }
    }
    let tool_call_updates: Option<HashMap<String, String>> = if is_incremental {
        updated_tool_calls.get(&s.id).map(|m| {
            m.iter()
                .map(|(id, content)| (format!("msg-{}", id), content.clone()))
                .collect()
        })
    } else {
        None
    };
    let pending_questions = s
        .pending_questions
        .as_deref()
        .and_then(|pq| serde_json::from_str(pq).ok());
    let pending_permission = s
        .pending_permission
        .as_deref()
        .and_then(|p| serde_json::from_str(p).ok());
    let resumable = (s.status == "paused" || s.status == "completed" || s.status == "error")
        && s.runtime_session_id.is_some();

    SessionState {
        session_db_id: s.id,
        agent_type: s.agent_type,
        status: s.status,
        subprocess_id: s.subprocess_id,
        model: s.model,
        profile: s.profile,
        blocks,
        max_message_id,
        is_incremental,
        tool_call_updates,
        pending_questions,
        has_file_changes: s.has_file_changes != 0,
        resumable,
        runtime_provider: s.runtime_provider,
        runtime_session_id: s.runtime_session_id,
        todos: todos_by_session.get(&s.id).cloned(),
        permission_mode: s
            .permission_mode
            .unwrap_or_else(|| "acceptEdits".to_string()),
        codex_permission_mode: s
            .codex_permission_mode
            .unwrap_or_else(|| "default".to_string()),
        pending_permission,
        input_tokens: s.input_tokens.unwrap_or(0),
        output_tokens: s.output_tokens.unwrap_or(0),
        context_window: s.context_window,
        was_compacted: s.was_compacted != 0,
        draft_prompt: s.draft_prompt,
        has_more: *has_more_map.get(&s.id).unwrap_or(&false) || trimmed_has_more,
        oldest_message_id: trimmed_oldest_id.or_else(|| {
            oldest_message_id_map
                .get(&s.id)
                .copied()
                .or_else(|| msgs.first().map(|m| m.id))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    #[tokio::test]
    async fn test_get_feature_agent_state_basic() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let feature_id = fid.0;

        let session_id = insert_session(&pool, feature_id, "completed").await;
        insert_message(&pool, session_id, "text", "hello", None, None, None).await;

        let state = get_feature_agent_state(&pool, feature_id, None, None, None)
            .await
            .unwrap();
        assert_eq!(state.sessions.len(), 1);
        let s = &state.sessions[0];
        assert_eq!(s.session_db_id, session_id);
        assert_eq!(s.blocks.len(), 1);
        assert_eq!(s.blocks[0].content, "hello");
    }

    #[tokio::test]
    async fn get_feature_agent_state_hydrates_message_origins() {
        let pool = setup_test_db().await;
        sqlx::query("CREATE TABLE agent_message_origins (message_id INTEGER PRIMARY KEY, origin_kind TEXT NOT NULL, source_session_id INTEGER, source_feature_id INTEGER, source_project_id INTEGER, source_message_id INTEGER, note TEXT, created_at TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let session_id = insert_session(&pool, fid.0, "completed").await;
        let msg_id = insert_message(
            &pool,
            session_id,
            "user_message",
            "delegated",
            None,
            None,
            None,
        )
        .await;
        sqlx::query(
            "INSERT INTO agent_message_origins
             (message_id, origin_kind, source_session_id, note)
             VALUES (?, 'session_generated', 123, 'helper prompt')",
        )
        .bind(msg_id)
        .execute(&pool)
        .await
        .unwrap();

        let state = get_feature_agent_state(&pool, fid.0, None, None, None)
            .await
            .unwrap();

        let origin = state.sessions[0].blocks[0].origin.as_ref().expect("origin");
        assert_eq!(origin.origin_kind, "session_generated");
        assert_eq!(origin.source_session_id, Some(123));
        assert_eq!(origin.note.as_deref(), Some("helper prompt"));
    }

    #[tokio::test]
    async fn test_get_feature_agent_state_incremental() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let feature_id = fid.0;

        let session_id = insert_session(&pool, feature_id, "running").await;
        let msg1 = insert_message(&pool, session_id, "text", "old message", None, None, None).await;
        let msg2 =
            insert_message(&pool, session_id, "text", " new message", None, None, None).await;

        // Fetch with after_message_ids = {session_id: msg1}
        let mut after = HashMap::new();
        after.insert(session_id, msg1);
        let state = get_feature_agent_state(&pool, feature_id, Some(after), None, None)
            .await
            .unwrap();
        assert_eq!(state.sessions.len(), 1);
        let s = &state.sessions[0];
        assert!(s.is_incremental);
        // Only the new message (msg2) should be in blocks
        assert_eq!(s.blocks.len(), 1);
        assert_eq!(s.blocks[0].content, " new message");
        assert_eq!(s.max_message_id, msg2);
    }

    #[tokio::test]
    async fn test_get_feature_agent_state_no_sessions() {
        let pool = setup_test_db().await;
        let state = get_feature_agent_state(&pool, 9999, None, None, None)
            .await
            .unwrap();
        assert!(state.sessions.is_empty());
    }

    #[tokio::test]
    async fn test_get_feature_agent_state_with_limit() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let feature_id = fid.0;
        let session_id = insert_session(&pool, feature_id, "completed").await;

        // Insert 5 messages
        for i in 0..5 {
            insert_message(
                &pool,
                session_id,
                "text",
                &format!("msg {}", i),
                None,
                None,
                None,
            )
            .await;
        }

        // Fetch with limit=3 — should get only the last 3 messages
        let state = get_feature_agent_state(&pool, feature_id, None, Some(3), None)
            .await
            .unwrap();
        let s = &state.sessions[0];
        assert!(s.has_more, "should indicate more messages exist");
        assert!(s.oldest_message_id.is_some());
        // With limit=3 and text merging, blocks may be fewer than 3,
        // but max_message_id should be the last message
        assert!(s.max_message_id > 0);
    }

    #[tokio::test]
    async fn test_get_feature_agent_state_with_before() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let feature_id = fid.0;
        let session_id = insert_session(&pool, feature_id, "completed").await;

        let mut msg_ids = Vec::new();
        for i in 0..5 {
            let id = insert_message(
                &pool,
                session_id,
                "tool_call",
                &format!("{{\"cmd\":\"{}\"}}", i),
                Some("Bash"),
                Some(&format!("tu-{}", i)),
                None,
            )
            .await;
            msg_ids.push(id);
        }

        // Fetch messages before msg_ids[3] with limit=2
        let mut before_map = HashMap::new();
        before_map.insert(session_id, msg_ids[3]);
        let state = get_feature_agent_state(&pool, feature_id, None, Some(2), Some(before_map))
            .await
            .unwrap();
        let s = &state.sessions[0];
        // Should get messages with id < msg_ids[3], limited to 2
        assert_eq!(s.blocks.len(), 2);
        assert!(s.has_more, "should have more messages before these");
    }

    #[tokio::test]
    async fn test_get_feature_agent_state_no_limit_no_has_more() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let feature_id = fid.0;
        let session_id = insert_session(&pool, feature_id, "completed").await;

        insert_message(&pool, session_id, "text", "hello", None, None, None).await;

        // Fetch without limit — has_more should be false
        let state = get_feature_agent_state(&pool, feature_id, None, None, None)
            .await
            .unwrap();
        let s = &state.sessions[0];
        assert!(!s.has_more);
    }
}
