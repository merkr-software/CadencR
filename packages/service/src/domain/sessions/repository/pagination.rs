//! Block-tree counting/capping helpers and the cross-page parent fetcher.
//!
//! All three pieces support pagination of `get_feature_agent_state`: the
//! cap/count helpers bound payload size on the wire, and
//! `fetch_missing_parents` repairs nesting when pagination splits a Task /
//! Agent tool_call from its children.

use sqlx::{AssertSqlSafe, SqlitePool};
use std::collections::HashSet;

use super::super::models::*;
use super::MESSAGE_SELECT;
use crate::error::AppError;

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

/// Fetch parent Agent/Task tool_call rows that are referenced by children in the
/// given message page but not already present. This lets `build_blocks` correctly
/// nest sub-agent children even when pagination splits parent from children.
pub(super) async fn fetch_missing_parents(
    pool: &SqlitePool,
    session_id: i64,
    msgs: &[AgentMessageRow],
) -> Result<Vec<AgentMessageRow>, AppError> {
    // Collect tool_use_ids of tool_call rows in this page
    let tool_call_tuids: HashSet<&str> = msgs
        .iter()
        .filter(|m| m.message_type == "tool_call")
        .filter_map(|m| m.tool_use_id.as_deref())
        .collect();

    let mut missing_tool_use_ids: HashSet<&str> = HashSet::new();

    for m in msgs {
        // Children whose parent_tool_use_id references a tool_call not in this page
        if let Some(ptuid) = m.parent_tool_use_id.as_deref() {
            if !tool_call_tuids.contains(ptuid) {
                missing_tool_use_ids.insert(ptuid);
            }
        // tool_results whose tool_use_id has no matching tool_call in this page
        // (build_blocks nests these via tool_use_id fallback)
        } else if m.message_type == "tool_result" || m.message_type == "tool_error" {
            if let Some(tuid) = m.tool_use_id.as_deref() {
                if !tool_call_tuids.contains(tuid) {
                    missing_tool_use_ids.insert(tuid);
                }
            }
        }
    }

    let missing: Vec<&str> = missing_tool_use_ids.into_iter().collect();

    if missing.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = missing.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "{MESSAGE_SELECT} FROM agent_messages WHERE session_id = ? AND message_type = 'tool_call' AND tool_use_id IN ({placeholders}) ORDER BY id ASC"
    );
    let mut q = sqlx::query_as::<_, AgentMessageRow>(AssertSqlSafe(sql)).bind(session_id);
    for tuid in &missing {
        q = q.bind(tuid);
    }
    Ok(q.fetch_all(pool).await?)
}

#[cfg(test)]
mod tests {
    use super::super::feature_state::get_feature_agent_state;
    use super::super::test_support::*;
    use super::*;

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
        let state = get_feature_agent_state(&pool, feature_id, None, Some(2), Some(before_map))
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

        let state = get_feature_agent_state(&pool, fid.0, None, Some(100), None)
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

        let state = get_feature_agent_state(&pool, fid.0, None, None, None)
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
