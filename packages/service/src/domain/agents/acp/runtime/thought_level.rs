//! Shared ACP thought-level / effort config option names.

use agent_client_protocol::schema::v1::{SessionConfigOption, SessionConfigOptionCategory};

/// True when a `config_option_update` name or Cursor config id should mirror
/// into Cadencr's thinking-effort session state.
pub fn is_thought_level_config_name(name: &str) -> bool {
    matches!(
        name,
        "thinkingEffort" | "effort" | "reasoning" | "thought_level"
    )
}

/// Resolve the live selector that owns Cadencr's durable thinking-effort
/// control. Prefer the ACP category, while retaining compatibility with older
/// agents that only exposed a conventional option id.
pub fn thought_level_config_id(options: &[SessionConfigOption]) -> Option<String> {
    options
        .iter()
        .find(|option| {
            matches!(
                option.category,
                Some(SessionConfigOptionCategory::ThoughtLevel)
            )
        })
        .or_else(|| {
            options
                .iter()
                .find(|option| is_thought_level_config_name(option.id.0.as_ref()))
        })
        .map(|option| option.id.0.to_string())
}

#[cfg(test)]
mod tests {
    use super::thought_level_config_id;
    use agent_client_protocol::schema::v1::SessionConfigOption;
    use serde_json::json;

    #[test]
    fn resolves_category_then_legacy_id() {
        let categorized: Vec<SessionConfigOption> = serde_json::from_value(json!([{
            "id": "provider-thinking",
            "name": "Thinking",
            "category": "thought_level",
            "type": "select",
            "currentValue": "medium",
            "options": [{ "value": "medium", "name": "Medium" }]
        }]))
        .unwrap();
        assert_eq!(
            thought_level_config_id(&categorized).as_deref(),
            Some("provider-thinking")
        );

        let legacy: Vec<SessionConfigOption> = serde_json::from_value(json!([{
            "id": "effort",
            "name": "Effort",
            "type": "select",
            "currentValue": "high",
            "options": [{ "value": "high", "name": "High" }]
        }]))
        .unwrap();
        assert_eq!(thought_level_config_id(&legacy).as_deref(), Some("effort"));
    }
}
