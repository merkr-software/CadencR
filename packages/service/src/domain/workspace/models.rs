use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub use crate::domain::agents::runtime::ProviderSettings as AgentProviderSettings;

#[derive(Debug, Serialize, ToSchema)]
pub struct Setting {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ModelSettings {
    pub session: String,
    pub auto_name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetSettingRequest {
    pub value: String,
}

/// Several workspace keys written in one atomic pass. A `null` value removes the
/// key, so its default applies again (the sidebar display options' reset).
#[derive(Debug, Deserialize, ToSchema)]
pub struct SetSettingsBatchRequest {
    pub values: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetModelSettingRequest {
    pub agent_type: String,
    pub model_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetProviderSettingRequest {
    pub agent_type: String,
    pub provider_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_setting_serialization() {
        let s = Setting {
            key: "theme".to_string(),
            value: Some("dark".to_string()),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"key\":\"theme\""));
        assert!(json.contains("\"value\":\"dark\""));
    }

    #[test]
    fn test_setting_null_value_serialization() {
        let s = Setting {
            key: "missing".to_string(),
            value: None,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"value\":null"));
    }

    #[test]
    fn test_model_settings_serialization() {
        let ms = ModelSettings {
            session: "opus[1m]".to_string(),
            auto_name: "haiku".to_string(),
        };
        let json = serde_json::to_string(&ms).unwrap();
        assert!(json.contains("\"session\""));
        assert!(json.contains("\"auto_name\""));
    }

    #[test]
    fn test_set_setting_request_deserialization() {
        let json = r#"{"value":"dark"}"#;
        let req: SetSettingRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.value, "dark");
    }

    #[test]
    fn test_set_model_setting_request_deserialization() {
        let json = r#"{"agent_type":"session","model_id":"claude-sonnet-3-5"}"#;
        let req: SetModelSettingRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.agent_type, "session");
        assert_eq!(req.model_id, "claude-sonnet-3-5");
    }
}
