//! Helpers for assembling the JSON payload of `session/prompt`. Includes
//! the Cadencr `Value` content → ACP `ContentBlock[]` conversion used to
//! build the `prompt` array, plus [`build_prompt_params`] which decides
//! whether to ride model/effort along with the prompt (legacy fallback)
//! or rely on `session/set_config_option` having pre-set them.
//!
//! The W4 prompt-turn lifecycle (lock + drain + result emission) lives in
//! [`super::turn_lifecycle`].

use serde_json::{json, Value};

pub(in crate::domain::agents) fn supports_prompt_steering(
    meta: Option<&serde_json::Map<String, Value>>,
) -> bool {
    meta.and_then(|meta| meta.get("cadencr"))
        .and_then(|meta| meta.get("promptSteering"))
        .and_then(Value::as_bool)
        == Some(true)
}

/// Convert Cadencr-shaped content into an ACP prompt block array.
///
/// Accepted inputs (in order of preference):
/// - `String`: wrapped as a single text block.
/// - `Array`: each element converted via `convert_block` (text, image,
///   audio, resource_link, resource, or unknown-passthrough).
/// - `Object` of the form `{ type: "...", ... }`: treated as a single block.
/// - Anything else: stringified and wrapped as a text block as a defensive
///   fallback so the agent always receives *something*.
pub fn acp_prompt_blocks_from_content(content: Value) -> Vec<Value> {
    match content {
        Value::String(text) => vec![text_block(text)],
        Value::Array(items) => items.into_iter().map(convert_block).collect(),
        Value::Object(_) => vec![convert_block(content)],
        Value::Null => Vec::new(),
        other => vec![text_block(other.to_string())],
    }
}

fn convert_block(value: Value) -> Value {
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return text_block(value.to_string());
    };
    match kind {
        "text" => {
            let text = value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            text_block(text)
        }
        "image" => image_block(&value),
        "audio" => audio_block(&value),
        "resource_link" => resource_link_block(&value),
        "resource" => resource_block(&value),
        _ => value,
    }
}

fn text_block(text: String) -> Value {
    json!({ "type": "text", "text": text })
}

fn image_block(value: &Value) -> Value {
    if let (Some(data), Some(mime_type)) = (
        value
            .get("source")
            .and_then(|s| s.get("data"))
            .and_then(Value::as_str),
        value
            .get("source")
            .and_then(|s| s.get("media_type"))
            .and_then(Value::as_str),
    ) {
        return json!({ "type": "image", "data": data, "mimeType": mime_type });
    }
    if value.get("data").is_some() && value.get("mimeType").is_some() {
        return value.clone();
    }
    value.clone()
}

fn audio_block(value: &Value) -> Value {
    if value.get("data").is_some() && value.get("mimeType").is_some() {
        return value.clone();
    }
    value.clone()
}

fn resource_link_block(value: &Value) -> Value {
    value.clone()
}

fn resource_block(value: &Value) -> Value {
    value.clone()
}

/// Assemble the JSON payload for `session/prompt`.
///
/// Model + thinking effort can travel with the prompt as legacy non-schema
/// extensions for older `opencode acp` builds that don't implement
/// `session/set_config_option`. Once the agent has acknowledged
/// `set_config_option`, callers pass `supports_set_config_option = true`
/// and we drop the ride-along fields entirely so the prompt stays
/// schema-clean.
pub fn build_prompt_params(
    session_id: &str,
    prompt: Vec<Value>,
    model: Option<&str>,
    effort: Option<&str>,
    supports_set_config_option: bool,
) -> Value {
    let mut params = json!({ "sessionId": session_id, "prompt": prompt });
    if supports_set_config_option {
        // Schema-correct path: agent already knows the active model/effort
        // from prior `session/set_config_option` calls. Don't echo.
        return params;
    }
    if let Some(model) = model {
        params["model"] = Value::String(model.to_string());
    }
    if let Some(effort) = effort {
        params["_meta"] = json!({ "thinkingEffort": effort });
    }
    params
}

#[cfg(test)]
mod tests {
    use super::{acp_prompt_blocks_from_content, build_prompt_params};
    use serde_json::json;

    #[test]
    fn string_becomes_single_text_block() {
        let blocks = acp_prompt_blocks_from_content(json!("hello"));
        assert_eq!(blocks, vec![json!({ "type": "text", "text": "hello" })]);
    }

    #[test]
    fn array_of_text_blocks_passes_through() {
        let blocks = acp_prompt_blocks_from_content(json!([
            { "type": "text", "text": "first" },
            { "type": "text", "text": "second" },
        ]));
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["text"], "first");
        assert_eq!(blocks[1]["text"], "second");
    }

    #[test]
    fn anthropic_style_image_block_is_converted() {
        let blocks = acp_prompt_blocks_from_content(json!([
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": "BASE64=="
                }
            }
        ]));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "image");
        assert_eq!(blocks[0]["mimeType"], "image/png");
        assert_eq!(blocks[0]["data"], "BASE64==");
        assert!(blocks[0].get("source").is_none());
    }

    #[test]
    fn audio_passes_through_when_already_acp_shape() {
        let blocks = acp_prompt_blocks_from_content(json!([
            { "type": "audio", "data": "AAAA", "mimeType": "audio/wav" }
        ]));
        assert_eq!(blocks[0]["data"], "AAAA");
        assert_eq!(blocks[0]["mimeType"], "audio/wav");
    }

    #[test]
    fn resource_link_passes_through() {
        let block = json!({
            "type": "resource_link",
            "uri": "file:///foo.md",
            "name": "foo"
        });
        let blocks = acp_prompt_blocks_from_content(json!([block.clone()]));
        assert_eq!(blocks, vec![block]);
    }

    #[test]
    fn unknown_type_passes_through_as_is() {
        let block = json!({ "type": "exotic", "payload": 42 });
        let blocks = acp_prompt_blocks_from_content(json!([block.clone()]));
        assert_eq!(blocks, vec![block]);
    }

    #[test]
    fn null_content_returns_empty() {
        assert!(acp_prompt_blocks_from_content(json!(null)).is_empty());
    }

    #[test]
    fn object_without_type_is_coerced_to_text_so_input_is_never_lost() {
        let blocks = acp_prompt_blocks_from_content(json!({ "foo": "bar" }));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "text");
        assert!(blocks[0]["text"].as_str().unwrap().contains("foo"));
    }

    #[test]
    fn build_prompt_params_omits_optional_fields_when_unset() {
        let params = build_prompt_params("s-1", vec![json!({})], None, None, false);
        assert_eq!(params["sessionId"], "s-1");
        assert!(params.get("model").is_none() && params.get("_meta").is_none());
    }

    #[test]
    fn build_prompt_params_attaches_model_and_effort_in_legacy_mode() {
        let params = build_prompt_params("s-1", vec![], Some("gpt-5.5"), Some("high"), false);
        assert_eq!(params["model"], "gpt-5.5");
        assert_eq!(params["_meta"]["thinkingEffort"], "high");
    }

    #[test]
    fn build_prompt_params_drops_model_and_meta_when_set_config_option_supported() {
        let params = build_prompt_params("s-1", vec![], Some("gpt-5.5"), Some("high"), true);
        assert!(params.get("model").is_none() && params.get("_meta").is_none());
        assert_eq!(params["sessionId"], "s-1");
    }
}
