//! Assembly and wire-budgeting for one hydrated session.

use std::collections::HashMap;

use crate::domain::agents::default_provider_id;
use crate::domain::agents::permission_modes::default_permission_mode_wire;

use super::super::models::*;
use super::blocks::build_blocks;
use super::byte_pagination::{
    trim_blocks_to_byte_cap, trim_newest_blocks_to_byte_cap, SESSION_WIRE_SOFT_CAP_BYTES,
};
use super::pagination::{block_message_id, trim_blocks_to_cap, BLOCK_SOFT_CAP};
use super::wire_preview::content_preview;

fn build_block_page(
    msgs: &[AgentMessageRow],
    is_incremental: bool,
    fallback_after: i64,
) -> (Vec<AgentBlock>, i64, bool, Option<i64>, bool) {
    let max_message_id = msgs
        .iter()
        .map(|message| message.id)
        .max()
        .unwrap_or(if is_incremental { fallback_after } else { 0 });
    let mut blocks = build_blocks(msgs);
    if is_incremental {
        let first_dropped =
            trim_newest_blocks_to_byte_cap(&mut blocks, SESSION_WIRE_SOFT_CAP_BYTES);
        let page_cursor = first_dropped
            .map(|id| id.saturating_sub(1).max(fallback_after))
            .unwrap_or(max_message_id);
        return (blocks, page_cursor, false, None, first_dropped.is_some());
    }
    let mut trimmed = false;
    let mut oldest = None;
    if trim_blocks_to_cap(&mut blocks, BLOCK_SOFT_CAP) > 0 {
        trimmed = true;
        oldest = blocks.iter().filter_map(block_message_id).min();
    }
    if let Some(max_dropped_id) = trim_blocks_to_byte_cap(&mut blocks, SESSION_WIRE_SOFT_CAP_BYTES)
    {
        trimmed = true;
        oldest = Some(max_dropped_id.saturating_add(1));
    }
    (blocks, max_message_id, trimmed, oldest, false)
}

fn preview_tool_updates(
    messages: Option<&HashMap<i64, String>>,
) -> (Option<HashMap<String, String>>, Option<Vec<String>>) {
    let mut truncated_ids = Vec::new();
    let updates = messages.map(|messages| {
        messages
            .iter()
            .map(|(id, content)| {
                let block_id = format!("msg-{id}");
                let (preview, truncated) = content_preview(content);
                if truncated {
                    truncated_ids.push(block_id.clone());
                }
                (block_id, preview)
            })
            .collect()
    });
    (
        updates,
        (!truncated_ids.is_empty()).then_some(truncated_ids),
    )
}

#[bon::builder]
pub(super) fn build_session_state(
    s: AgentSessionRow,
    msgs: Vec<AgentMessageRow>,
    is_incremental: bool,
    revision_cursors: &HashMap<i64, i64>,
    revision_has_more: &HashMap<i64, bool>,
    message_has_more: &HashMap<i64, bool>,
    message_cursors: &HashMap<i64, i64>,
    after_map: &HashMap<i64, i64>,
    updated_tool_calls: &HashMap<i64, HashMap<i64, String>>,
    todos_by_session: &mut HashMap<i64, Vec<serde_json::Value>>,
    has_more_map: &HashMap<i64, bool>,
    oldest_message_id_map: &HashMap<i64, i64>,
) -> SessionState {
    let max_content_revision = if is_incremental {
        revision_cursors
            .get(&s.id)
            .copied()
            .unwrap_or(s.message_revision)
    } else {
        s.message_revision
    };
    let (blocks, built_max_message_id, trimmed_has_more, trimmed_oldest_id, trimmed_incremental) =
        build_block_page(
            &msgs,
            is_incremental,
            after_map.get(&s.id).copied().unwrap_or(0),
        );
    let max_message_id = if is_incremental {
        message_cursors
            .get(&s.id)
            .map(|cursor| (*cursor).min(built_max_message_id))
            .unwrap_or(built_max_message_id)
    } else {
        built_max_message_id
    };
    let (tool_call_updates, truncated_tool_call_update_ids) = preview_tool_updates(
        is_incremental
            .then(|| updated_tool_calls.get(&s.id))
            .flatten(),
    );
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
    // A NULL mode (e.g. schedule-spawned sessions) runs with the provider
    // default, so report that rather than a provider-agnostic guess.
    let permission_mode = s.permission_mode.unwrap_or_else(|| {
        default_permission_mode_wire(
            s.runtime_provider
                .as_deref()
                .unwrap_or(default_provider_id()),
        )
        .into_owned()
    });

    SessionState {
        session_db_id: s.id,
        agent_type: s.agent_type,
        status: s.status,
        subprocess_id: s.subprocess_id,
        model: s.model,
        profile: s.profile,
        blocks,
        max_message_id,
        max_content_revision: Some(max_content_revision),
        has_more_content_revisions: revision_has_more.get(&s.id).copied(),
        has_more_incremental_messages: message_has_more
            .get(&s.id)
            .copied()
            .map(|has_more| has_more || trimmed_incremental),
        is_incremental,
        tool_call_updates,
        truncated_tool_call_update_ids,
        pending_questions,
        has_file_changes: s.has_file_changes != 0,
        resumable,
        runtime_provider: s.runtime_provider,
        runtime_session_id: s.runtime_session_id,
        todos: todos_by_session.get(&s.id).cloned(),
        permission_mode,
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
