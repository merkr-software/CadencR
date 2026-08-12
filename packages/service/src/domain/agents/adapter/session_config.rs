//! Provider-neutral session configuration negotiated by a live runtime.
//!
//! IDs and values are opaque transport data. Shared code may use the optional
//! category as a presentation hint, but correctness must never depend on a
//! provider name or a hardcoded option id.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RuntimeSessionConfigSnapshot {
    pub options: Vec<RuntimeSessionConfigOption>,
}

impl RuntimeSessionConfigSnapshot {
    pub fn select_current_value(&self, config_id: &str) -> Option<&str> {
        self.options
            .iter()
            .find(|option| option.id == config_id)
            .and_then(|option| match &option.kind {
                RuntimeSessionConfigKind::Select { current_value, .. } => {
                    Some(current_value.as_str())
                }
                RuntimeSessionConfigKind::Boolean { .. } => None,
            })
    }

    pub fn validate_value(
        &self,
        config_id: &str,
        value: &RuntimeSessionConfigValue,
    ) -> Result<(), String> {
        let option = self
            .options
            .iter()
            .find(|option| option.id == config_id)
            .ok_or_else(|| format!("unknown session configuration option `{config_id}`"))?;
        match (&option.kind, value) {
            (
                RuntimeSessionConfigKind::Select { choices, .. },
                RuntimeSessionConfigValue::Select(value),
            ) if choices.contains(value) => Ok(()),
            (RuntimeSessionConfigKind::Select { .. }, RuntimeSessionConfigValue::Select(value)) => {
                Err(format!(
                    "session configuration option `{config_id}` does not advertise value `{value}`"
                ))
            }
            (RuntimeSessionConfigKind::Boolean { .. }, RuntimeSessionConfigValue::Boolean(_)) => {
                Ok(())
            }
            (RuntimeSessionConfigKind::Select { .. }, RuntimeSessionConfigValue::Boolean(_)) => {
                Err(format!(
                    "session configuration option `{config_id}` expects a select value"
                ))
            }
            (RuntimeSessionConfigKind::Boolean { .. }, RuntimeSessionConfigValue::Select(_)) => {
                Err(format!(
                    "session configuration option `{config_id}` expects a boolean value"
                ))
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RuntimeSessionConfigOption {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// ACP semantic category (`model`, `thought_level`, custom `_...`, etc.).
    /// Kept as an opaque string so newer protocol categories round-trip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(flatten)]
    pub kind: RuntimeSessionConfigKind,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeSessionConfigKind {
    Select {
        current_value: String,
        choices: RuntimeSessionConfigChoices,
    },
    Boolean {
        current_value: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "layout", rename_all = "snake_case")]
pub enum RuntimeSessionConfigChoices {
    Ungrouped {
        options: Vec<RuntimeSessionConfigSelectOption>,
    },
    Grouped {
        groups: Vec<RuntimeSessionConfigSelectGroup>,
    },
}

impl RuntimeSessionConfigChoices {
    fn contains(&self, value: &str) -> bool {
        match self {
            Self::Ungrouped { options } => options.iter().any(|option| option.value == value),
            Self::Grouped { groups } => groups
                .iter()
                .flat_map(|group| &group.options)
                .any(|option| option.value == value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RuntimeSessionConfigSelectOption {
    pub value: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RuntimeSessionConfigSelectGroup {
    pub id: String,
    pub name: String,
    pub options: Vec<RuntimeSessionConfigSelectOption>,
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum RuntimeSessionConfigValue {
    Select(String),
    Boolean(bool),
}

#[cfg(test)]
mod tests {
    use super::{
        RuntimeSessionConfigChoices, RuntimeSessionConfigKind, RuntimeSessionConfigOption,
        RuntimeSessionConfigSelectOption, RuntimeSessionConfigSnapshot, RuntimeSessionConfigValue,
    };

    fn snapshot() -> RuntimeSessionConfigSnapshot {
        RuntimeSessionConfigSnapshot {
            options: vec![RuntimeSessionConfigOption {
                id: "model".to_string(),
                name: "Model".to_string(),
                description: None,
                category: Some("model".to_string()),
                kind: RuntimeSessionConfigKind::Select {
                    current_value: "m1".to_string(),
                    choices: RuntimeSessionConfigChoices::Ungrouped {
                        options: vec![RuntimeSessionConfigSelectOption {
                            value: "m1".to_string(),
                            name: "Model 1".to_string(),
                            description: None,
                            meta: None,
                        }],
                    },
                },
                meta: None,
            }],
        }
    }

    #[test]
    fn validates_only_advertised_values_for_the_matching_kind() {
        let snapshot = snapshot();
        assert!(snapshot
            .validate_value(
                "model",
                &RuntimeSessionConfigValue::Select("m1".to_string())
            )
            .is_ok());
        assert!(snapshot
            .validate_value(
                "model",
                &RuntimeSessionConfigValue::Select("m2".to_string())
            )
            .is_err());
        assert!(snapshot
            .validate_value("model", &RuntimeSessionConfigValue::Boolean(true))
            .is_err());
        assert!(snapshot
            .validate_value(
                "missing",
                &RuntimeSessionConfigValue::Select("m1".to_string())
            )
            .is_err());
    }
}
