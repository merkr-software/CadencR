//! Flatten ACP `ToolCallContent[]` into the text the desktop renders.

use serde_json::Value;

pub(crate) fn flatten_tool_result_content_with<'a>(
    blocks: &'a [Value],
    unwrap_text: impl Fn(&'a Value) -> Option<&'a str>,
) -> Value {
    if blocks.is_empty() {
        return serde_json::json!(blocks);
    }
    let mut texts = Vec::with_capacity(blocks.len());
    for block in blocks {
        let Some(text) = unwrap_text(block) else {
            return serde_json::json!(blocks);
        };
        texts.push(text);
    }
    Value::String(texts.join("\n"))
}

pub(super) fn unwrap_text_block(block: &Value) -> Option<&str> {
    let kind = block.get("type").and_then(Value::as_str)?;
    match kind {
        "text" => block.get("text").and_then(Value::as_str),
        _ => None,
    }
}

/// Text of a `{type:"text"}` block, or of one wrapped in the
/// `{type:"content", content:{…}}` envelope OpenCode and Cursor send.
pub(crate) fn unwrap_nested_text_block(block: &Value) -> Option<&str> {
    match block.get("type").and_then(Value::as_str)? {
        "text" => block.get("text").and_then(Value::as_str),
        "content" => block.get("content").and_then(unwrap_nested_text_block),
        _ => None,
    }
}
