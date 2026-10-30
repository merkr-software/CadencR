//! Conversion from mutable assembly nodes to wire DTO blocks.

use super::super::models::AgentBlock;
use super::blocks::MutableBlock;
use super::wire_preview::{content_preview, tool_content_preview, user_message_preview};

pub(super) fn convert_block(idx: usize, all: &[MutableBlock]) -> AgentBlock {
    let b = &all[idx];
    let (content, preview_truncated) = match b.type_.as_str() {
        "user_message" => user_message_preview(&b.content),
        "tool_call" | "tool_result" => tool_content_preview(&b.content),
        _ => content_preview(&b.content),
    };
    // A block already cut before it got here (Bash tail truncation) no longer
    // knows its full size, so it reports none rather than an understated one.
    let full_content_bytes =
        (preview_truncated && b.truncated_content != Some(true)).then(|| b.content.len() as u64);
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
        full_content_bytes,
        origin: b.origin.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::blocks::build_blocks;
    use super::super::test_support::*;
    use super::super::wire_preview::CONTENT_PREVIEW_MAX_BYTES;

    #[test]
    fn preview_truncation_reports_the_full_size() {
        let content = "a".repeat(CONTENT_PREVIEW_MAX_BYTES * 2);
        let blocks = build_blocks(&[make_message(7, 1, "text", &content)]);

        assert_eq!(blocks[0].truncated_content, Some(true));
        assert_eq!(blocks[0].full_content_bytes, Some(content.len() as u64));
    }

    #[test]
    fn stripped_screenshot_payload_is_neither_truncated_nor_sized() {
        let result = serde_json::json!([{
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "A".repeat(CONTENT_PREVIEW_MAX_BYTES * 2)}
        }])
        .to_string();
        let messages = [
            make_message_full(
                1,
                1,
                "tool_call",
                "{}",
                Some("mcp__browser__shot"),
                Some("tu"),
                None,
            ),
            make_message_full(2, 1, "tool_result", &result, None, Some("tu"), None),
        ];
        let blocks = build_blocks(&messages);

        assert_eq!(blocks[1].truncated_content, None);
        assert_eq!(blocks[1].full_content_bytes, None);
        assert!(!blocks[1].content.contains("AAAA"));
    }

    #[test]
    fn bash_tail_truncation_reports_no_size() {
        let output = (0..400)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let messages = [
            make_message_full(1, 1, "tool_call", "{}", Some("Bash"), Some("tu"), None),
            make_message_full(2, 1, "tool_result", &output, None, Some("tu"), None),
        ];
        let blocks = build_blocks(&messages);

        assert_eq!(blocks[1].truncated_content, Some(true));
        assert_eq!(blocks[1].full_content_bytes, None);
    }
}
