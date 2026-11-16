use crate::domain::agents::acp::runtime::provider_hooks::{
    flatten_tool_result_content_with, unwrap_nested_text_block,
};
use serde_json::Value;

pub(super) fn flatten_tool_result_content(content: &[Value]) -> Value {
    flatten_tool_result_content_with(content, unwrap_nested_text_block)
}

#[cfg(test)]
mod tests {
    use super::flatten_tool_result_content;
    use serde_json::json;

    #[test]
    fn flatten_collapses_text_only_blocks_into_a_string() {
        let payload = flatten_tool_result_content(&[
            json!({ "type": "text", "text": "line one" }),
            json!({ "type": "text", "text": "line two" }),
        ]);
        assert_eq!(payload, json!("line one\nline two"));
    }

    #[test]
    fn flatten_passes_structured_blocks_through_and_handles_empty_input() {
        let blocks = vec![json!({ "type": "diff", "path": "/x", "newText": "x" })];
        let payload = flatten_tool_result_content(&blocks);
        assert!(payload.is_array());
        assert_eq!(payload[0]["type"], "diff");
        let empty = flatten_tool_result_content(&[]);
        assert!(empty.is_array());
        assert!(empty.as_array().unwrap().is_empty());
    }

    #[test]
    fn flatten_unwraps_opencode_content_envelope() {
        let payload = flatten_tool_result_content(&[json!({
            "type": "content",
            "content": { "type": "text", "text": "(no output)" }
        })]);
        assert_eq!(payload, json!("(no output)"));
    }

    #[test]
    fn flatten_handles_mixed_envelope_and_bare_text() {
        let payload = flatten_tool_result_content(&[
            json!({ "type": "content", "content": { "type": "text", "text": "first" } }),
            json!({ "type": "text", "text": "second" }),
        ]);
        assert_eq!(payload, json!("first\nsecond"));
    }
}
