//! Serialization-safe previews for persisted conversation content.

use serde_json::Value;

pub(super) const CONTENT_PREVIEW_MAX_BYTES: usize = 64 * 1024;
const METADATA_STRING_MAX_BYTES: usize = 4 * 1024;
const TRUNCATION_MARKER: &str = "… [preview truncated; expand to load full content]";

pub(super) fn content_preview(content: &str) -> (String, bool) {
    if content.len() <= CONTENT_PREVIEW_MAX_BYTES {
        return (content.to_owned(), false);
    }
    let Ok(value) = serde_json::from_str::<Value>(content) else {
        return (prefix_with_marker(content, CONTENT_PREVIEW_MAX_BYTES), true);
    };
    value_preview(value)
}

/// Bound an already-parsed oversized JSON value, keeping it valid JSON.
fn value_preview(mut value: Value) -> (String, bool) {
    let overhead = structural_json_bytes(&value);
    if overhead >= CONTENT_PREVIEW_MAX_BYTES {
        return (fallback_preview(), true);
    }
    // Six bytes per source byte is serde_json's worst case (`\u00xx`). This
    // conservative budget needs one mutation walk + one final serialization.
    let mut source_budget = (CONTENT_PREVIEW_MAX_BYTES - overhead) / 6;
    cap_short_strings(&mut value, &mut source_budget);
    cap_long_strings(&mut value, &mut source_budget);
    let preview = serde_json::to_string(&value).unwrap_or_else(|_| fallback_preview());
    debug_assert!(preview.len() <= CONTENT_PREVIEW_MAX_BYTES);
    (preview, true)
}

pub(super) fn user_message_preview(content: &str) -> (String, bool) {
    if content.len() <= CONTENT_PREVIEW_MAX_BYTES {
        return (content.to_owned(), false);
    }
    let Ok(mut blocks) = serde_json::from_str::<Vec<Value>>(content) else {
        return content_preview(content);
    };
    let mut removed_payload = false;
    for block in &mut blocks {
        let Some(object) = block.as_object_mut() else {
            continue;
        };
        if let Some(source) = object.get_mut("source").and_then(Value::as_object_mut) {
            removed_payload |= remove_inline_data(source);
        }
        removed_payload |= remove_inline_data(object);
    }
    let without_binary = serde_json::to_string(&blocks).unwrap_or_default();
    let (preview, text_truncated) = content_preview(&without_binary);
    (preview, removed_payload || text_truncated)
}

/// Tool content without its inline image payloads. No renderer draws an image
/// out of a tool call or result (an MCP screenshot is for the agent, not the
/// transcript), so a dropped payload is not content the preview is missing and
/// does not flag it: only text that still overflows does.
pub(super) fn tool_content_preview(content: &str) -> (String, bool) {
    if content.len() <= CONTENT_PREVIEW_MAX_BYTES {
        return (content.to_owned(), false);
    }
    let Ok(mut value) = serde_json::from_str::<Value>(content) else {
        return content_preview(content);
    };
    // Parsed once: a multi-MB tool payload must not be parsed again per page.
    if remove_image_payloads(&mut value) {
        if let Ok(without_images) = serde_json::to_string(&value) {
            if without_images.len() <= CONTENT_PREVIEW_MAX_BYTES {
                return (without_images, false);
            }
        }
    }
    value_preview(value)
}

/// Covers both wire shapes: Anthropic `{type:image, source:{data}}` and MCP
/// `{type:image, data, mimeType}`, at any depth of the result envelope.
fn remove_image_payloads(value: &mut Value) -> bool {
    match value {
        Value::Array(values) => values.iter_mut().fold(false, |removed, value| {
            remove_image_payloads(value) | removed
        }),
        Value::Object(object) => {
            let mut removed = false;
            if object.get("type").and_then(Value::as_str) == Some("image") {
                removed |= remove_inline_data(object);
                if let Some(source) = object.get_mut("source").and_then(Value::as_object_mut) {
                    removed |= remove_inline_data(source);
                }
            }
            object.values_mut().fold(removed, |removed, value| {
                remove_image_payloads(value) | removed
            })
        }
        _ => false,
    }
}

fn remove_inline_data(object: &mut serde_json::Map<String, Value>) -> bool {
    let inline = object
        .get("data")
        .and_then(Value::as_str)
        .is_some_and(|data| !data.starts_with("cadencr-blob://"));
    if inline {
        object.remove("data");
    }
    inline
}

fn structural_json_bytes(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(number) => number.to_string().len(),
        Value::String(_) => 2,
        Value::Array(values) => {
            2 + values.iter().map(structural_json_bytes).sum::<usize>()
                + values.len().saturating_sub(1)
        }
        Value::Object(values) => {
            2 + values
                .iter()
                .map(|(key, value)| json_string_bytes(key) + 1 + structural_json_bytes(value))
                .sum::<usize>()
                + values.len().saturating_sub(1)
        }
    }
}

fn cap_short_strings(value: &mut Value, budget: &mut usize) {
    match value {
        Value::String(text) if text.len() <= METADATA_STRING_MAX_BYTES => {
            if text.len() <= *budget {
                *budget -= text.len();
            } else {
                *text = prefix_with_marker(text, *budget);
                *budget = 0;
            }
        }
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| cap_short_strings(value, budget)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|value| cap_short_strings(value, budget)),
        _ => {}
    }
}

fn cap_long_strings(value: &mut Value, budget: &mut usize) {
    match value {
        Value::String(text) if text.len() > METADATA_STRING_MAX_BYTES => {
            let allowance = (*budget).min(text.len());
            *text = prefix_with_marker(text, allowance);
            *budget = budget.saturating_sub(allowance);
        }
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| cap_long_strings(value, budget)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|value| cap_long_strings(value, budget)),
        _ => {}
    }
}

fn json_string_bytes(content: &str) -> usize {
    2 + content
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\u{0008}' | '\u{000C}' | '\n' | '\r' | '\t' => 2,
            '\u{0000}'..='\u{001F}' => 6,
            other => other.len_utf8(),
        })
        .sum::<usize>()
}

fn fallback_preview() -> String {
    r#"{"_cadencrPreview":"structure too large; expand to load full content"}"#.to_string()
}

fn prefix_with_marker(content: &str, max_bytes: usize) -> String {
    if max_bytes <= TRUNCATION_MARKER.len() {
        return String::new();
    }
    let mut end = (max_bytes - TRUNCATION_MARKER.len()).min(content.len());
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATION_MARKER}", &content[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_plain_text_at_a_utf8_boundary() {
        let (preview, truncated) = content_preview(&"🦀".repeat(CONTENT_PREVIEW_MAX_BYTES));
        assert!(truncated && preview.len() <= CONTENT_PREVIEW_MAX_BYTES);
        assert!(preview.ends_with(TRUNCATION_MARKER));
    }

    #[test]
    fn structured_preview_is_valid_and_keeps_short_metadata() {
        let content = serde_json::json!({
            "status": "completed", "file_path": "src/main.rs",
            "result": "x".repeat(CONTENT_PREVIEW_MAX_BYTES * 140),
        })
        .to_string();
        let (preview, truncated) = content_preview(&content);
        let parsed: Value = serde_json::from_str(&preview).expect("valid preview json");
        assert!(truncated && preview.len() <= CONTENT_PREVIEW_MAX_BYTES);
        assert_eq!(parsed["status"], "completed");
        assert_eq!(parsed["file_path"], "src/main.rs");
    }

    #[test]
    fn huge_many_leaf_structure_has_a_bounded_valid_fallback() {
        let content = serde_json::to_string(&vec![0; CONTENT_PREVIEW_MAX_BYTES]).unwrap();
        let (preview, truncated) = content_preview(&content);
        assert!(truncated && preview.len() <= CONTENT_PREVIEW_MAX_BYTES);
        assert!(serde_json::from_str::<Value>(&preview).is_ok());
    }

    #[test]
    fn user_preview_never_emits_partial_base64() {
        let content = serde_json::json!([{
            "type": "text", "text": "please inspect"
        }, {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "A".repeat(CONTENT_PREVIEW_MAX_BYTES * 2)}
        }, {
            "type": "attachment", "file_name": "data.bin", "media_type": "application/octet-stream",
            "kind": "document", "data": "B".repeat(CONTENT_PREVIEW_MAX_BYTES * 2)
        }]).to_string();
        let (preview, truncated) = user_message_preview(&content);
        let parsed: Value = serde_json::from_str(&preview).unwrap();
        assert!(truncated && preview.len() <= CONTENT_PREVIEW_MAX_BYTES);
        assert_eq!(parsed[0]["text"], "please inspect");
        assert!(parsed[1]["source"].get("data").is_none());
        assert!(parsed[2].get("data").is_none());
        assert_eq!(parsed[2]["file_name"], "data.bin");
    }

    #[test]
    fn tool_preview_drops_screenshot_payloads_without_flagging_truncation() {
        let content = serde_json::json!([{
            "type": "text", "text": "Took a screenshot of the current page's viewport."
        }, {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "A".repeat(CONTENT_PREVIEW_MAX_BYTES * 2)}
        }, {
            "content": [{"type": "image", "mimeType": "image/jpeg", "data": "B".repeat(CONTENT_PREVIEW_MAX_BYTES)}]
        }])
        .to_string();
        let (preview, truncated) = tool_content_preview(&content);
        let parsed: Value = serde_json::from_str(&preview).unwrap();
        assert!(!truncated);
        assert_eq!(
            parsed[0]["text"],
            "Took a screenshot of the current page's viewport."
        );
        assert_eq!(parsed[1]["source"]["media_type"], "image/png");
        assert!(parsed[1]["source"].get("data").is_none());
        assert!(parsed[2]["content"][0].get("data").is_none());
    }

    #[test]
    fn tool_preview_still_flags_text_that_overflows() {
        let image =
            serde_json::json!({"type": "image", "data": "A".repeat(CONTENT_PREVIEW_MAX_BYTES)});
        let with_text = serde_json::json!([image, {"type": "text", "text": "x".repeat(CONTENT_PREVIEW_MAX_BYTES * 2)}]);
        let (preview, truncated) = tool_content_preview(&with_text.to_string());
        assert!(truncated && preview.len() <= CONTENT_PREVIEW_MAX_BYTES);
        assert!(serde_json::from_str::<Value>(&preview).unwrap()[0]
            .get("data")
            .is_none());

        let plain = "y".repeat(CONTENT_PREVIEW_MAX_BYTES * 2);
        assert_eq!(tool_content_preview(&plain), content_preview(&plain));
    }
}
