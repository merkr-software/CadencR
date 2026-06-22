//! Port of the shared `buildBlocks` from the desktop side: turns a flat
//! `agent_messages` stream into the nested `AgentBlock` tree the frontend
//! renders. Heavy per-type logic for tool_call / tool_result lives in the
//! sibling `tool_blocks` module so this file stays under the 400-line cap.

use std::collections::HashMap;

use super::super::models::*;
use super::tool_blocks::{handle_tool_call, handle_tool_result};

pub(super) struct MutableBlock {
    pub(super) id: String,
    pub(super) type_: String,
    pub(super) content: String,
    pub(super) tool_name: Option<String>,
    pub(super) tool_use_id: Option<String>,
    pub(super) parent_tool_use_id: Option<String>,
    pub(super) is_error: Option<bool>,
    pub(super) source_tool_name: Option<String>,
    pub(super) created_at: Option<String>,
    pub(super) model: Option<String>,
    pub(super) origin: Option<AgentMessageOrigin>,
    pub(super) has_child_slots: bool, // Task/Agent get child slots
    pub(super) child_indices: Vec<usize>,
    pub(super) truncated_content: Option<bool>,
}

fn convert_block(idx: usize, all: &[MutableBlock]) -> AgentBlock {
    let b = &all[idx];
    let child_blocks = if b.has_child_slots || !b.child_indices.is_empty() {
        Some(
            b.child_indices
                .iter()
                .map(|&ci| convert_block(ci, all))
                .collect(),
        )
    } else {
        None
    };
    AgentBlock {
        id: b.id.clone(),
        type_: b.type_.clone(),
        content: b.content.clone(),
        tool_name: b.tool_name.clone(),
        tool_args: if b.type_ == "tool_call" {
            Some(b.content.clone())
        } else {
            None
        },
        is_error: b.is_error,
        tool_use_id: b.tool_use_id.clone(),
        parent_tool_use_id: b.parent_tool_use_id.clone(),
        child_blocks,
        source_tool_name: b.source_tool_name.clone(),
        created_at: b.created_at.clone(),
        model: b.model.clone(),
        truncated_content: b.truncated_content,
        origin: b.origin.clone(),
    }
}

/// Push `block` and link it to its parent (or root) list. Returns the
/// new index. Shared by the simple branches that don't merge with prior
/// blocks.
fn push_block(
    block: MutableBlock,
    parent_idx: Option<usize>,
    all: &mut Vec<MutableBlock>,
    root_indices: &mut Vec<usize>,
) -> usize {
    let new_idx = all.len();
    all.push(block);
    if let Some(pidx) = parent_idx {
        all[pidx].child_indices.push(new_idx);
    } else {
        root_indices.push(new_idx);
    }
    new_idx
}

/// `text`/`text_delta` and `thinking`/`thinking_delta` share the same
/// "merge into preceding sibling of the same type, else push" behavior.
/// `include_model` is true only for text (the streaming text path tracks the
/// model used for each turn; thinking deltas don't).
fn push_or_merge_streaming(
    block_type: &str,
    msg: &AgentMessageRow,
    id: String,
    parent_id: Option<&str>,
    parent_idx: Option<usize>,
    include_model: bool,
    all: &mut Vec<MutableBlock>,
    root_indices: &mut Vec<usize>,
) {
    let last_idx_opt = if let Some(pidx) = parent_idx {
        all[pidx].child_indices.last().copied()
    } else {
        root_indices.last().copied()
    };
    let should_merge = last_idx_opt.is_some_and(|li| {
        all[li].type_ == block_type && all[li].parent_tool_use_id.as_deref() == parent_id
    });

    if should_merge {
        let last_idx = last_idx_opt.unwrap();
        all[last_idx].content.push_str(&msg.content);
        return;
    }
    push_block(
        MutableBlock {
            id,
            type_: block_type.to_string(),
            content: msg.content.clone(),
            tool_name: None,
            tool_use_id: None,
            parent_tool_use_id: msg.parent_tool_use_id.clone(),
            is_error: None,
            source_tool_name: None,
            created_at: msg.created_at.clone(),
            model: if include_model {
                msg.model.clone()
            } else {
                None
            },
            origin: msg.origin.clone(),
            has_child_slots: false,
            child_indices: Vec::new(),
            truncated_content: None,
        },
        parent_idx,
        all,
        root_indices,
    );
}

/// Build a `MutableBlock` for the simple "just push it" branches
/// (`user_message`, `error`, `compact_divider`, `clear_divider`).
fn make_simple_block(
    type_: &str,
    content: String,
    msg: &AgentMessageRow,
    id: String,
    is_error: Option<bool>,
    include_created_at: bool,
) -> MutableBlock {
    MutableBlock {
        id,
        type_: type_.to_string(),
        content,
        tool_name: None,
        tool_use_id: None,
        parent_tool_use_id: msg.parent_tool_use_id.clone(),
        is_error,
        source_tool_name: None,
        created_at: if include_created_at {
            msg.created_at.clone()
        } else {
            None
        },
        model: None,
        origin: msg.origin.clone(),
        has_child_slots: false,
        child_indices: Vec::new(),
        truncated_content: None,
    }
}

pub(super) fn build_blocks(messages: &[AgentMessageRow]) -> Vec<AgentBlock> {
    let mut all: Vec<MutableBlock> = Vec::new();
    let mut tool_use_id_map: HashMap<String, usize> = HashMap::new();
    let mut root_indices: Vec<usize> = Vec::new();

    for msg in messages {
        let id = format!("msg-{}", msg.id);
        let parent_id = msg.parent_tool_use_id.as_deref();
        let parent_idx = parent_id.and_then(|pid| tool_use_id_map.get(pid).copied());

        match msg.message_type.as_str() {
            "text" | "text_delta" => push_or_merge_streaming(
                "text",
                msg,
                id,
                parent_id,
                parent_idx,
                true,
                &mut all,
                &mut root_indices,
            ),
            "thinking" | "thinking_delta" => push_or_merge_streaming(
                "thinking",
                msg,
                id,
                parent_id,
                parent_idx,
                false,
                &mut all,
                &mut root_indices,
            ),
            "tool_call" => handle_tool_call(
                msg,
                id,
                parent_idx,
                &mut all,
                &mut tool_use_id_map,
                &mut root_indices,
            ),
            "tool_result" | "tool_error" => handle_tool_result(
                msg,
                id,
                parent_idx,
                &mut all,
                &mut tool_use_id_map,
                &mut root_indices,
            ),
            "user_message" => {
                push_block(
                    make_simple_block("user_message", msg.content.clone(), msg, id, None, true),
                    parent_idx,
                    &mut all,
                    &mut root_indices,
                );
            }
            "error" => {
                push_block(
                    make_simple_block("error", msg.content.clone(), msg, id, None, false),
                    parent_idx,
                    &mut all,
                    &mut root_indices,
                );
            }
            "compact_divider" => {
                push_block(
                    make_simple_block("compact_divider", msg.content.clone(), msg, id, None, false),
                    parent_idx,
                    &mut all,
                    &mut root_indices,
                );
            }
            "clear_divider" => {
                push_block(
                    make_simple_block("clear_divider", String::new(), msg, id, None, false),
                    parent_idx,
                    &mut all,
                    &mut root_indices,
                );
            }
            _ => {}
        }
    }

    root_indices
        .iter()
        .map(|&idx| convert_block(idx, &all))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    #[test]
    fn test_build_blocks_empty() {
        let blocks = build_blocks(&[]);
        assert!(blocks.is_empty());
    }

    #[test]
    fn test_build_blocks_single_text() {
        let msgs = vec![make_message(1, 1, "text", "hello world")];
        let blocks = build_blocks(&msgs);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].type_, "text");
        assert_eq!(blocks[0].content, "hello world");
    }

    #[test]
    fn test_build_blocks_text_merging() {
        let msgs = vec![
            make_message(1, 1, "text", "hello"),
            make_message(2, 1, "text", " world"),
        ];
        let blocks = build_blocks(&msgs);
        assert_eq!(blocks.len(), 1, "consecutive text blocks should merge");
        assert_eq!(blocks[0].content, "hello world");
    }

    #[test]
    fn test_build_blocks_thinking_merging() {
        let msgs = vec![
            make_message(1, 1, "thinking", "first thought"),
            make_message(2, 1, "thinking", " second thought"),
        ];
        let blocks = build_blocks(&msgs);
        assert_eq!(blocks.len(), 1, "consecutive thinking blocks should merge");
        assert_eq!(blocks[0].type_, "thinking");
        assert_eq!(blocks[0].content, "first thought second thought");
    }

    #[test]
    fn test_build_blocks_mixed_sequence() {
        let msgs = vec![
            make_message(1, 1, "text", "Starting"),
            make_message_full(2, 1, "tool_call", "{}", Some("Bash"), Some("tu-1"), None),
            make_message_full(3, 1, "tool_result", "done", None, Some("tu-1"), None),
            make_message(4, 1, "text", "Done"),
        ];
        let blocks = build_blocks(&msgs);
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0].type_, "text");
        assert_eq!(blocks[1].type_, "tool_call");
        assert_eq!(blocks[2].type_, "tool_result");
        assert_eq!(blocks[3].type_, "text");
    }

    #[test]
    fn test_build_blocks_user_message() {
        let msgs = vec![
            make_message(1, 1, "user_message", "Hello from user"),
            make_message(2, 1, "text", "Hello from assistant"),
        ];
        let blocks = build_blocks(&msgs);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].type_, "user_message");
        assert_eq!(blocks[0].content, "Hello from user");
        assert_eq!(blocks[1].type_, "text");
        assert_eq!(blocks[1].content, "Hello from assistant");
    }

    #[test]
    fn test_build_blocks_user_message_preserves_origin() {
        let mut msg = make_message(1, 1, "user_message", "Delegated prompt");
        msg.origin = Some(AgentMessageOrigin {
            origin_kind: "session_generated".to_string(),
            source_session_id: Some(123),
            source_feature_id: Some(45),
            source_project_id: Some(6),
            source_message_id: Some(789),
            note: Some("spawned helper".to_string()),
            created_at: Some("2026-06-18T12:00:00Z".to_string()),
        });

        let blocks = build_blocks(&[msg]);

        let origin = blocks[0].origin.as_ref().expect("origin");
        assert_eq!(origin.origin_kind, "session_generated");
        assert_eq!(origin.source_session_id, Some(123));
        assert_eq!(origin.note.as_deref(), Some("spawned helper"));
    }

    #[test]
    fn test_build_blocks_user_message_not_merged_with_text() {
        // User messages should never merge with adjacent text blocks
        let msgs = vec![
            make_message(1, 1, "text", "Assistant text"),
            make_message(2, 1, "user_message", "User prompt"),
            make_message(3, 1, "text", "More assistant text"),
        ];
        let blocks = build_blocks(&msgs);
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].type_, "text");
        assert_eq!(blocks[1].type_, "user_message");
        assert_eq!(blocks[2].type_, "text");
    }

    #[test]
    fn test_build_blocks_error_message_becomes_error_block() {
        // Persisted error messages surface as their own `error` block kind in
        // the API response (the frontend renders them with a dedicated UI).
        let msgs = vec![make_message(1, 1, "error", "OpenCode stream failed")];
        let blocks = build_blocks(&msgs);

        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].type_, "error");
        assert_eq!(blocks[0].content, "OpenCode stream failed");
    }
}
