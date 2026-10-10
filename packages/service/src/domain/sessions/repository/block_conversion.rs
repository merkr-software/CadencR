//! Conversion from mutable assembly nodes to wire DTO blocks.

use super::super::models::AgentBlock;
use super::blocks::MutableBlock;
use super::wire_preview::{content_preview, user_message_preview};

pub(super) fn convert_block(idx: usize, all: &[MutableBlock]) -> AgentBlock {
    let b = &all[idx];
    let (content, preview_truncated) = if b.type_ == "user_message" {
        user_message_preview(&b.content)
    } else {
        content_preview(&b.content)
    };
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
        message_uuid: b.message_uuid.clone(),
        prompt_delivery_state: b.prompt_delivery_state,
        type_: b.type_.clone(),
        content: content.clone(),
        tool_name: b.tool_name.clone(),
        tool_args: if b.type_ == "tool_call" {
            Some(content)
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
        truncated_content: (preview_truncated || b.truncated_content == Some(true)).then_some(true),
        origin: b.origin.clone(),
    }
}
