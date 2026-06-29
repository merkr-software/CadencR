use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Token usage for context window tracking.
///
/// Cadencr tracks cumulative input (including cache tokens) and output tokens
/// per agent session to monitor context window consumption.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
}

impl Usage {
    /// Total input cost tokens = input + cache_creation + cache_read.
    ///
    /// This represents overall context window consumption.
    pub fn total_input_tokens(&self) -> u64 {
        self.input_tokens
            + self.cache_creation_input_tokens.unwrap_or(0)
            + self.cache_read_input_tokens.unwrap_or(0)
    }
}

/// A content block in a message. Tagged by the `type` field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    Thinking {
        thinking: String,
        signature: Option<String>,
    },
    ToolResult {
        tool_use_id: String,
        content: Value,
        is_error: Option<bool>,
    },
    /// Any block type the CLI emits that we don't model yet (e.g. a new
    /// `server_tool_use`, `web_search_tool_result`, or image block). Catching
    /// it here keeps an unknown *sibling* block from sinking the entire
    /// assistant message into `SdkMessage::Unknown` — the known text/tool
    /// blocks beside it still parse and surface.
    #[serde(other)]
    Other,
}

/// A streaming content delta. Tagged by the `type` field.
///
/// These are the **critical path** for real-time UI streaming — Cadencr processes
/// these events via `stream_event` messages (content_block_delta).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentDelta {
    /// Real-time text chunks from the assistant.
    TextDelta { text: String },
    /// Partial tool input JSON chunks (accumulate to form complete JSON).
    InputJsonDelta { partial_json: String },
    /// Real-time thinking chunks.
    ThinkingDelta { thinking: String },
    /// Any delta type the CLI emits that we don't model yet (e.g.
    /// `signature_delta` or `citations_delta`). Catching it here keeps an
    /// unknown delta from sinking the whole `stream_event` into
    /// `SdkMessage::Unknown` and dropping the live turn.
    #[serde(other)]
    Other,
}

/// A slash command available in the CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
}

/// Information about an available model, as reported by the CLI's `initialize`
/// control-response. Wire format uses camelCase (e.g. `displayName`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Model identifier to pass via `--model` (e.g. `"opus"`, `"sonnet[1m]"`,
    /// `"default"`).
    pub value: String,
    /// Human-readable display name (e.g. `"Opus"`, `"Sonnet (1M context)"`).
    pub display_name: String,
    /// Description of the model's capabilities.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub supports_effort: Option<bool>,
    #[serde(default)]
    pub supported_effort_levels: Option<Vec<String>>,
    #[serde(default)]
    pub supports_adaptive_thinking: Option<bool>,
    #[serde(default)]
    pub supports_fast_mode: Option<bool>,
    #[serde(default)]
    pub supports_auto_mode: Option<bool>,
}

/// Information about a sub-agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub name: String,
    pub description: Option<String>,
}

/// Account information. Uses `serde(flatten)` for forward-compatibility with
/// new fields the CLI may add in future versions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    #[serde(flatten)]
    pub extra: Value,
}

/// Status of a connected MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub name: String,
    pub status: String,
}

/// Records a tool use that was denied (e.g. via permission system).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionDenial {
    pub tool_name: String,
    pub tool_use_id: String,
    pub tool_input: Value,
}

/// Metadata attached to a `compact_boundary` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactMetadata {
    pub trigger: String,
    pub pre_tokens: u64,
}

/// Information about a loaded plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub name: String,
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── Usage::total_input_tokens ────────────────────────────────────────────

    #[test]
    fn usage_total_input_no_cache() {
        let u = Usage {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
        };
        assert_eq!(u.total_input_tokens(), 100);
    }

    #[test]
    fn usage_total_input_with_cache_creation() {
        let u = Usage {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: Some(200),
            cache_read_input_tokens: None,
        };
        assert_eq!(u.total_input_tokens(), 300);
    }

    #[test]
    fn usage_total_input_with_all_cache() {
        let u = Usage {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: Some(200),
            cache_read_input_tokens: Some(50),
        };
        assert_eq!(u.total_input_tokens(), 350);
    }

    #[test]
    fn usage_default_has_zeros() {
        let u = Usage::default();
        assert_eq!(u.total_input_tokens(), 0);
        assert_eq!(u.output_tokens, 0);
    }

    // ── ContentBlock serde roundtrip ─────────────────────────────────────────

    #[test]
    fn content_block_text_roundtrip() {
        let block = ContentBlock::Text {
            text: "hello world".into(),
        };
        let json = serde_json::to_string(&block).unwrap();
        let back: ContentBlock = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, ContentBlock::Text { text } if text == "hello world"));
    }

    #[test]
    fn content_block_tool_use_roundtrip() {
        let block = ContentBlock::ToolUse {
            id: "tu_123".into(),
            name: "bash".into(),
            input: json!({ "command": "ls" }),
        };
        let json = serde_json::to_string(&block).unwrap();
        let back: ContentBlock = serde_json::from_str(&json).unwrap();
        assert!(
            matches!(back, ContentBlock::ToolUse { id, name, .. } if id == "tu_123" && name == "bash")
        );
    }

    #[test]
    fn content_block_thinking_roundtrip() {
        let block = ContentBlock::Thinking {
            thinking: "let me reason...".into(),
            signature: Some("sig_abc".into()),
        };
        let json = serde_json::to_string(&block).unwrap();
        let back: ContentBlock = serde_json::from_str(&json).unwrap();
        assert!(
            matches!(back, ContentBlock::Thinking { thinking, signature } if thinking == "let me reason..." && signature == Some("sig_abc".into()))
        );
    }

    #[test]
    fn content_block_tool_result_roundtrip() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "tu_456".into(),
            content: json!("output text"),
            is_error: Some(false),
        };
        let json = serde_json::to_string(&block).unwrap();
        let back: ContentBlock = serde_json::from_str(&json).unwrap();
        assert!(
            matches!(back, ContentBlock::ToolResult { tool_use_id, is_error, .. } if tool_use_id == "tu_456" && is_error == Some(false))
        );
    }

    // ── ContentDelta serde roundtrip ─────────────────────────────────────────

    #[test]
    fn content_delta_text_delta_roundtrip() {
        let delta = ContentDelta::TextDelta {
            text: "streaming text".into(),
        };
        let json = serde_json::to_string(&delta).unwrap();
        let back: ContentDelta = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, ContentDelta::TextDelta { text } if text == "streaming text"));
    }

    #[test]
    fn content_delta_input_json_delta_roundtrip() {
        let delta = ContentDelta::InputJsonDelta {
            partial_json: r#"{"cmd":"#.into(),
        };
        let json = serde_json::to_string(&delta).unwrap();
        let back: ContentDelta = serde_json::from_str(&json).unwrap();
        assert!(
            matches!(back, ContentDelta::InputJsonDelta { partial_json } if partial_json == r#"{"cmd":"#)
        );
    }

    #[test]
    fn content_delta_thinking_delta_roundtrip() {
        let delta = ContentDelta::ThinkingDelta {
            thinking: "step 1: analyze".into(),
        };
        let json = serde_json::to_string(&delta).unwrap();
        let back: ContentDelta = serde_json::from_str(&json).unwrap();
        assert!(
            matches!(back, ContentDelta::ThinkingDelta { thinking } if thinking == "step 1: analyze")
        );
    }

    // ── ModelInfo serde ──────────────────────────────────────────────────────

    #[test]
    fn model_info_parses_cli_payload() {
        let raw = json!({
            "value": "default",
            "displayName": "Default (recommended)",
            "description": "Opus 4.7 with 1M context · Most capable for complex work",
            "supportsEffort": true,
            "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
            "supportsAdaptiveThinking": true,
            "supportsAutoMode": true
        });
        let info: ModelInfo = serde_json::from_value(raw).unwrap();
        assert_eq!(info.value, "default");
        assert_eq!(info.display_name, "Default (recommended)");
        assert_eq!(info.supports_effort, Some(true));
        assert_eq!(
            info.supported_effort_levels.as_deref(),
            Some(
                ["low", "medium", "high", "xhigh", "max"]
                    .map(String::from)
                    .as_slice()
            )
        );
        assert_eq!(info.supports_auto_mode, Some(true));
        assert_eq!(info.supports_fast_mode, None);
    }

    #[test]
    fn model_info_parses_minimal_payload() {
        let raw = json!({ "value": "haiku", "displayName": "Haiku" });
        let info: ModelInfo = serde_json::from_value(raw).unwrap();
        assert_eq!(info.value, "haiku");
        assert_eq!(info.display_name, "Haiku");
        assert!(info.description.is_none());
        assert!(info.supports_effort.is_none());
    }

    // ── AccountInfo forward-compat ───────────────────────────────────────────

    #[test]
    fn account_info_captures_unknown_fields() {
        let raw = json!({
            "email": "user@example.com",
            "plan": "pro",
            "future_field": 42
        });
        let info: AccountInfo = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(info.extra["email"], "user@example.com");
        assert_eq!(info.extra["plan"], "pro");
        assert_eq!(info.extra["future_field"], 42);
    }
}
