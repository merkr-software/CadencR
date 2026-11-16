use agent_client_protocol::schema::v1::Meta;
use serde_json::{Map, Value};

use crate::domain::agents::adapter::{RuntimePurpose, RuntimeSpawnConfig};

/// ACP extension metadata for Cadencr-specific session launch purposes.
const CADENCR_META_KEY: &str = "com.cadencr";

pub(super) fn session_meta(config: &RuntimeSpawnConfig) -> Option<Meta> {
    let RuntimePurpose::AutoName = config.purpose?;
    let mut task = Map::new();
    task.insert(
        "purpose".to_string(),
        Value::String("auto_name".to_string()),
    );
    if let Some(system_prompt) = config.system_prompt.as_deref() {
        task.insert(
            "systemPrompt".to_string(),
            Value::String(system_prompt.to_string()),
        );
    }

    let mut meta = Map::new();
    meta.insert(CADENCR_META_KEY.to_string(), Value::Object(task));
    Some(meta)
}

#[cfg(test)]
mod tests {
    use super::session_meta;
    use crate::domain::agents::adapter::{RuntimePurpose, RuntimeSpawnConfig};
    use serde_json::json;

    #[test]
    fn auto_name_metadata_has_the_cadencr_payload() {
        let config = RuntimeSpawnConfig {
            purpose: Some(RuntimePurpose::AutoName),
            system_prompt: Some("Return a concise session title.".to_string()),
            ..RuntimeSpawnConfig::default()
        };

        let meta = session_meta(&config).expect("auto-name purpose should produce metadata");

        assert_eq!(
            serde_json::to_value(meta).expect("ACP metadata should serialize"),
            json!({
                "com.cadencr": {
                    "purpose": "auto_name",
                    "systemPrompt": "Return a concise session title."
                }
            })
        );
    }

    #[test]
    fn auto_name_metadata_omits_an_absent_system_prompt() {
        let config = RuntimeSpawnConfig {
            purpose: Some(RuntimePurpose::AutoName),
            ..RuntimeSpawnConfig::default()
        };

        let meta = session_meta(&config).expect("auto-name purpose should produce metadata");

        assert_eq!(
            serde_json::to_value(meta).expect("ACP metadata should serialize"),
            json!({
                "com.cadencr": {
                    "purpose": "auto_name"
                }
            })
        );
    }

    #[test]
    fn metadata_is_omitted_when_purpose_is_unset() {
        let config = RuntimeSpawnConfig {
            system_prompt: Some("Do not mark this as an auto-name task.".to_string()),
            ..RuntimeSpawnConfig::default()
        };

        assert!(session_meta(&config).is_none());
    }
}
