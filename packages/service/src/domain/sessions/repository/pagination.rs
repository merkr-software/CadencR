//! Block-tree counting/capping helpers and the cross-page parent fetcher.
//!
//! All three pieces support pagination of `get_feature_agent_state`: the
//! cap/count helpers bound payload size on the wire, and
//! `fetch_missing_parents` repairs nesting when pagination splits a Task /
//! Agent tool_call from its children.

use sqlx::{AssertSqlSafe, SqlitePool};
use std::collections::{HashMap, HashSet};

use super::super::models::*;
use super::MESSAGE_SELECT;
use crate::error::AppError;

const MISSING_PARENT_PAIR_CHUNK_SIZE: usize = 200;

/// Soft cap on the total number of blocks (root + nested) returned by a single
/// `get_feature_agent_state` call. The wire payload for very long conversations
/// can dwarf the per-session message `limit` because each Bash call yields two
/// blocks (call + result) and Task agents nest children — so a message-level
/// cap is not a useful payload-size guard. When the block count exceeds this
/// value we drop the oldest root blocks (and their children) and report
/// `has_more = true` so the client can paginate with `before_message_ids`.
pub(super) const BLOCK_SOFT_CAP: usize = 400;

/// Count root + nested blocks (one level of `child_blocks`).
pub(super) fn total_block_count(blocks: &[AgentBlock]) -> usize {
    blocks
        .iter()
        .map(|b| 1 + b.child_blocks.as_ref().map_or(0, |c| c.len()))
        .sum()
}

/// Extract the numeric message id encoded in `AgentBlock::id` (`"msg-<n>"`).
pub(super) fn block_message_id(block: &AgentBlock) -> Option<i64> {
    block.id.strip_prefix("msg-").and_then(|s| s.parse().ok())
}

/// Drop the oldest root blocks (and their nested children) until the total
/// block count is at or below `cap`. Returns the number of root blocks that
/// were dropped. A caller should mark `has_more = true` and recompute the
/// oldest cursor when this is non-zero.
pub(super) fn trim_blocks_to_cap(blocks: &mut Vec<AgentBlock>, cap: usize) -> usize {
    let total = total_block_count(blocks);
    if total <= cap {
        return 0;
    }
    // Scan front-to-back accumulating child counts; stop as soon as dropping
    // up to `i` root entries would put us at or below the cap. Single O(n)
    // pass plus one `drain` — no quadratic recount or per-element memmove.
    let mut remaining = total;
    let mut dropped = 0usize;
    for block in blocks.iter() {
        if remaining <= cap {
            break;
        }
        remaining -= 1 + block.child_blocks.as_ref().map_or(0, |c| c.len());
        dropped += 1;
    }
    blocks.drain(0..dropped);
    dropped
}

fn collect_parent_refs(
    session_id: i64,
    rows: &[AgentMessageRow],
    known: &mut HashSet<(i64, String)>,
    pending: &mut HashSet<(i64, String)>,
) {
    for message in rows {
        if message.message_type == "tool_call" {
            if let Some(tool_use_id) = &message.tool_use_id {
                known.insert((session_id, tool_use_id.clone()));
            }
        }
        if let Some(parent) = &message.parent_tool_use_id {
            pending.insert((session_id, parent.clone()));
        }
        if matches!(message.message_type.as_str(), "tool_result" | "tool_error") {
            if let Some(tool_use_id) = &message.tool_use_id {
                pending.insert((session_id, tool_use_id.clone()));
            }
        }
    }
}

/// Iteratively fetch missing ancestor `tool_call` rows for `(session_id, tool_use_id)`
/// pairs until the transitive parent chain is closed (or dangling/cyclic).
async fn fetch_missing_parent_rows(
    pool: &SqlitePool,
    known: &mut HashSet<(i64, String)>,
    pending: &mut HashSet<(i64, String)>,
) -> Result<Vec<AgentMessageRow>, AppError> {
    let message_select_m = MESSAGE_SELECT
        .replacen("SELECT ", "SELECT m.", 1)
        .replace(", ", ", m.");
    let mut ancestors = Vec::new();
    loop {
        let missing: Vec<(i64, String)> = pending
            .drain()
            .filter(|pair| !known.contains(pair))
            .collect();
        if missing.is_empty() {
            break;
        }
        // Mark requested pairs before querying: malformed cycles and dangling
        // references terminate instead of being requested forever.
        known.extend(missing.iter().cloned());
        for chunk in missing.chunks(MISSING_PARENT_PAIR_CHUNK_SIZE) {
            let values = std::iter::repeat_n("(?, ?)", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "WITH needed(session_id, tool_use_id) AS (VALUES {values}) \
                 {message_select_m} FROM needed n \
                 CROSS JOIN agent_messages m \
                 WHERE m.session_id = n.session_id \
                   AND m.tool_use_id = n.tool_use_id \
                   AND m.message_type = 'tool_call'"
            );
            let mut query = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(sql));
            for (session_id, tool_use_id) in chunk {
                query = query.bind(session_id).bind(tool_use_id);
            }
            let fetched = query.fetch_all(pool).await?;
            for row in &fetched {
                if let Some(parent) = &row.parent_tool_use_id {
                    pending.insert((row.session_id, parent.clone()));
                }
            }
            ancestors.extend(fetched);
        }
    }
    Ok(ancestors)
}

/// Fetch parent Agent/Task tool_call rows that are referenced by children in the
/// given message page but not already present. This lets `build_blocks` correctly
/// nest sub-agent children even when pagination splits parent from children.
pub(super) async fn fetch_missing_parents(
    pool: &SqlitePool,
    session_id: i64,
    msgs: &[AgentMessageRow],
) -> Result<Vec<AgentMessageRow>, AppError> {
    let mut known = HashSet::new();
    let mut pending = HashSet::new();
    collect_parent_refs(session_id, msgs, &mut known, &mut pending);
    let mut ancestors = fetch_missing_parent_rows(pool, &mut known, &mut pending).await?;
    ancestors.sort_by_key(|message| message.id);
    Ok(ancestors)
}

/// Batched counterpart of [`fetch_missing_parents`] across multiple sessions.
pub(super) async fn fetch_missing_parents_batch(
    pool: &SqlitePool,
    messages_by_session: &mut HashMap<i64, Vec<AgentMessageRow>>,
) -> Result<(), AppError> {
    let mut known = HashSet::new();
    let mut pending = HashSet::new();
    for (&session_id, rows) in messages_by_session.iter() {
        collect_parent_refs(session_id, rows, &mut known, &mut pending);
    }
    for row in fetch_missing_parent_rows(pool, &mut known, &mut pending).await? {
        messages_by_session
            .entry(row.session_id)
            .or_default()
            .push(row);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::feature_state::get_feature_agent_state;
    use super::super::test_support::*;
    use super::*;

    #[tokio::test]
    async fn split_nested_tool_results_fetch_matching_calls_and_task_ancestry() {
        let pool = setup_test_db().await;
        let session_id = insert_session(&pool, 1, "completed").await;
        insert_message(
            &pool,
            session_id,
            "tool_call",
            "{}",
            Some("Task"),
            Some("task-1"),
            None,
        )
        .await;
        for (name, tool_use_id) in [("Bash", "bash-1"), ("ApplyPatch", "patch-1")] {
            insert_message(
                &pool,
                session_id,
                "tool_call",
                "{}",
                Some(name),
                Some(tool_use_id),
                Some("task-1"),
            )
            .await;
        }
        let mut result_ids = Vec::new();
        for tool_use_id in ["bash-1", "patch-1"] {
            result_ids.push(
                insert_message(
                    &pool,
                    session_id,
                    "tool_result",
                    "result",
                    None,
                    Some(tool_use_id),
                    Some("task-1"),
                )
                .await,
            );
        }

        for (result_id, matching_call) in result_ids.into_iter().zip(["bash-1", "patch-1"]) {
            let page = vec![sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(format!(
                "{MESSAGE_SELECT} FROM agent_messages WHERE id = ?"
            )))
            .bind(result_id)
            .fetch_one(&pool)
            .await
            .unwrap()];
            let ancestors = fetch_missing_parents(&pool, session_id, &page)
                .await
                .unwrap();
            let tool_ids: HashSet<_> = ancestors
                .iter()
                .filter_map(|message| message.tool_use_id.as_deref())
                .collect();
            assert_eq!(tool_ids, HashSet::from(["task-1", matching_call]));
            assert!(ancestors.iter().all(|message| message.id < result_id));
        }
    }

    #[test]
    fn test_trim_blocks_to_cap_no_op() {
        let mut blocks: Vec<AgentBlock> = (1..=5).map(make_root_block).collect();
        let dropped = trim_blocks_to_cap(&mut blocks, 10);
        assert_eq!(dropped, 0);
        assert_eq!(blocks.len(), 5);
    }

    #[test]
    fn test_trim_blocks_to_cap_drops_oldest_roots() {
        let mut blocks: Vec<AgentBlock> = (1..=10).map(make_root_block).collect();
        let dropped = trim_blocks_to_cap(&mut blocks, 4);
        assert_eq!(dropped, 6);
        assert_eq!(blocks.len(), 4);
        // The surviving blocks should be the newest 4 (ids 7..=10).
        assert_eq!(blocks.first().map(|b| b.id.as_str()), Some("msg-7"));
        assert_eq!(blocks.last().map(|b| b.id.as_str()), Some("msg-10"));
    }

    #[test]
    fn test_trim_blocks_to_cap_counts_children() {
        // A root with 9 children = 10 blocks total. Cap=10 → no trim.
        // Add another root → 11 blocks total → must drop the older root.
        let mut root_with_kids = make_root_block(1);
        root_with_kids.child_blocks = Some((100..=108).map(make_root_block).collect());
        let mut blocks = vec![root_with_kids, make_root_block(2)];
        assert_eq!(total_block_count(&blocks), 11);
        let dropped = trim_blocks_to_cap(&mut blocks, 10);
        assert_eq!(dropped, 1);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].id, "msg-2");
    }

    #[tokio::test]
    async fn test_paginated_cursor_ignores_injected_parent_rows() {
        use std::collections::HashMap;

        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let feature_id = fid.0;
        let session_id = insert_session(&pool, feature_id, "completed").await;

        let parent_id = insert_message(
            &pool,
            session_id,
            "tool_call",
            r#"{"description":"task"}"#,
            Some("Task"),
            Some("task-1"),
            None,
        )
        .await;
        let first_child_id = insert_message(
            &pool,
            session_id,
            "text",
            "older child",
            None,
            None,
            Some("task-1"),
        )
        .await;
        insert_message(
            &pool,
            session_id,
            "text",
            "newer child",
            None,
            None,
            Some("task-1"),
        )
        .await;
        let before_id =
            insert_message(&pool, session_id, "text", "outside page", None, None, None).await;

        let mut before_map = HashMap::new();
        before_map.insert(session_id, before_id);
        let state =
            get_feature_agent_state(&pool, feature_id, None, None, Some(2), Some(before_map))
                .await
                .unwrap();
        let s = &state.sessions[0];

        assert_eq!(s.oldest_message_id, Some(first_child_id));
        assert!(s.has_more);
        assert_ne!(s.oldest_message_id, Some(parent_id));
    }

    #[tokio::test]
    async fn latest_limited_hydration_keeps_initial_user_message_anchor() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let session_id = insert_session(&pool, fid.0, "completed").await;

        let initial_id = insert_message(
            &pool,
            session_id,
            "user_message",
            "original spawned prompt",
            None,
            None,
            None,
        )
        .await;
        for i in 0..105 {
            insert_message(
                &pool,
                session_id,
                "tool_call",
                "{}",
                Some("Read"),
                Some(&format!("tu-anchor-{i}")),
                None,
            )
            .await;
        }

        let state = get_feature_agent_state(&pool, fid.0, None, None, Some(100), None)
            .await
            .unwrap();
        let session = &state.sessions[0];

        assert!(session.has_more);
        assert_ne!(session.oldest_message_id, Some(initial_id));
        assert!(
            session
                .blocks
                .iter()
                .any(|block| block.type_ == "user_message"
                    && block.content == "original spawned prompt"),
            "initial user prompt should remain visible even when latest-window hydration is limited"
        );
    }

    #[tokio::test]
    async fn test_get_feature_agent_state_block_cap_trims_and_sets_has_more() {
        let pool = setup_test_db().await;
        let fid: (i64,) = sqlx::query_as("INSERT INTO features (title) VALUES ('f') RETURNING id")
            .fetch_one(&pool)
            .await
            .unwrap();
        let session_id = insert_session(&pool, fid.0, "completed").await;

        // Insert > BLOCK_SOFT_CAP messages (each becomes one root block: distinct
        // tool_calls so text-merging doesn't collapse them).
        let total = BLOCK_SOFT_CAP + 50;
        for i in 0..total {
            insert_message(
                &pool,
                session_id,
                "tool_call",
                "{}",
                Some("Read"),
                Some(&format!("tu-cap-{i}")),
                None,
            )
            .await;
        }

        let state = get_feature_agent_state(&pool, fid.0, None, None, None, None)
            .await
            .unwrap();
        let s = &state.sessions[0];
        assert!(s.has_more, "trimmed response should report has_more=true");
        assert!(s.oldest_message_id.is_some());
        assert!(
            s.blocks.len() <= BLOCK_SOFT_CAP,
            "block count {} exceeds cap {BLOCK_SOFT_CAP}",
            s.blocks.len()
        );
    }
}
