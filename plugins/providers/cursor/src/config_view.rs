//! The configuration view the connector presents to Cadencr.
//!
//! Cursor (with the parameterized model picker) advertises a base `model`
//! plus `fast` / thought-level companions. The host instead sees one `model`
//! select whose values are the cold `agent models` catalog ids, the Cursor
//! options it can use as-is (`mode`, decorated with Cadencr's permission-mode
//! `_meta`), and the connector-owned `access` select.

use agent_client_protocol::schema::v1::SessionConfigOption;
use serde_json::Value;

use crate::access::AccessMode;
use crate::cli::models::{catalog_entries, default_model_id, model_select_option, CursorModel};
use crate::model_config::{
    for_each_select_option, is_model_option, is_thought_level_config_name, CompanionValue,
    CursorModelConfigState,
};
use crate::modes::decorate_live_option;

#[derive(Debug, Default, Clone)]
pub struct SessionConfig {
    child_options: Vec<Value>,
    pub model_state: CursorModelConfigState,
    /// Catalog id last confirmed through `session/set_config_option`.
    pub applied_model: Option<String>,
}

fn typed(option: &Value) -> Option<SessionConfigOption> {
    serde_json::from_value(option.clone()).ok()
}

fn option_id(option: &Value) -> Option<&str> {
    option.get("id").and_then(Value::as_str)
}

impl SessionConfig {
    /// Observe Cursor's `configOptions`. A list carrying the `model` option is
    /// Cursor's full snapshot; any other list replaces matching ids only.
    pub fn observe(&mut self, options: &[Value]) {
        let typed_options: Vec<SessionConfigOption> = options.iter().filter_map(typed).collect();
        if typed_options.iter().any(is_model_option) {
            self.child_options = options.to_vec();
        } else {
            for option in options {
                let id = option_id(option);
                match self
                    .child_options
                    .iter_mut()
                    .find(|known| option_id(known) == id)
                {
                    Some(known) => *known = option.clone(),
                    None => self.child_options.push(option.clone()),
                }
            }
        }
        self.model_state.observe(&typed_options);
    }

    pub fn mode(&self) -> Option<String> {
        self.child_select_value("mode")
    }

    /// Record a value Cursor applied outside a `configOptions` snapshot
    /// (`session/set_mode`, `current_mode_update`, legacy single-option
    /// `config_option_update`).
    pub fn set_current(&mut self, id: &str, value: Value) {
        if let Some(option) = self
            .child_options
            .iter_mut()
            .find(|option| option_id(option) == Some(id))
        {
            option["currentValue"] = value;
        }
    }

    fn child_select_value(&self, id: &str) -> Option<String> {
        self.child_value(id).and_then(|value| match value {
            CompanionValue::Select(value) => Some(value),
            CompanionValue::Boolean(_) => None,
        })
    }

    fn child_value(&self, id: &str) -> Option<CompanionValue> {
        let current = self
            .child_options
            .iter()
            .find(|option| option_id(option) == Some(id))?
            .get("currentValue")?;
        match current {
            Value::String(value) => Some(CompanionValue::Select(value.clone())),
            Value::Bool(value) => Some(CompanionValue::Boolean(*value)),
            _ => None,
        }
    }

    fn is_hidden_companion(&self, option: &Value) -> bool {
        let id = option_id(option).unwrap_or("");
        self.model_state.is_companion_id(id)
            || is_thought_level_config_name(id)
            || option.get("category").and_then(Value::as_str) == Some("thought_level")
    }

    /// Model choices: the cold catalog, else ids derived from Cursor's live
    /// base models (`default` is Cursor's spelling of the catalog's `auto`).
    fn model_entries(&self, catalog: &[CursorModel]) -> Vec<(String, String)> {
        let mut entries = catalog_entries(catalog);
        if entries.is_empty() {
            let live = self
                .child_options
                .iter()
                .filter_map(typed)
                .find(is_model_option);
            if let Some(live) = live {
                for_each_select_option(&live, |select| {
                    let value = select.value.0.to_string();
                    let id = if value == "default" {
                        "auto".to_string()
                    } else {
                        value
                    };
                    entries.push((id, select.name.clone()));
                });
            }
        }
        if let Some(applied) = &self.applied_model {
            if !entries.iter().any(|(id, _)| id == applied) {
                entries.push((applied.clone(), applied.clone()));
            }
        }
        entries
    }

    /// The catalog id describing Cursor's live state: the last applied id, else
    /// the first entry whose decomposition matches the live model and its
    /// companions, else the catalog default.
    fn current_model(
        &self,
        entries: &[(String, String)],
        catalog: &[CursorModel],
    ) -> Option<String> {
        if let Some(applied) = &self.applied_model {
            return Some(applied.clone());
        }
        let live_model = self.child_select_value("model");
        let matches_live = |id: &str| {
            live_model.as_deref() == Some(self.model_state.model_config_value(id).as_str())
                && self
                    .model_state
                    .companions(id)
                    .iter()
                    .all(|(config_id, value)| self.child_value(config_id).as_ref() == Some(value))
        };
        entries
            .iter()
            .map(|(id, _)| id)
            .find(|id| matches_live(id))
            .cloned()
            .or_else(|| default_model_id(catalog).map(ToOwned::to_owned))
            .or_else(|| entries.first().map(|(id, _)| id.clone()))
    }

    /// Full `configOptions` list for the host.
    pub fn host_options(&self, catalog: &[CursorModel], access: AccessMode) -> Vec<Value> {
        let entries = self.model_entries(catalog);
        let model_option = self
            .current_model(&entries, catalog)
            .map(|current| model_select_option(&entries, &current));
        let mut options = Vec::with_capacity(self.child_options.len() + 1);
        let mut model_placed = false;
        for option in &self.child_options {
            if option_id(option) == Some("model") {
                if let Some(model) = model_option.clone() {
                    options.push(model);
                    model_placed = true;
                }
            } else if !self.is_hidden_companion(option) {
                let mut option = option.clone();
                decorate_live_option(&mut option);
                options.push(option);
            }
        }
        if let (false, Some(model)) = (model_placed, model_option) {
            options.push(model);
        }
        options.push(access.config_option());
        options
    }
}

/// Cursor's mode/config `configOptions`, if the payload carries them.
pub fn config_options_of(payload: &Value) -> Option<Vec<Value>> {
    payload
        .get("configOptions")
        .and_then(Value::as_array)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::SessionConfig;
    use crate::access::AccessMode;
    use crate::cli::models::parse_models_output;
    use serde_json::{json, Value};

    fn mode() -> Value {
        json!({
            "id": "mode", "name": "Mode", "category": "mode", "type": "select",
            "currentValue": "agent",
            "options": [{ "value": "agent", "name": "Agent" }, { "value": "plan", "name": "Plan" }]
        })
    }

    fn model(current: &str) -> Value {
        json!({
            "id": "model", "name": "Model", "category": "model", "type": "select",
            "currentValue": current,
            "options": [
                { "value": "default", "name": "Auto" },
                { "value": "composer-2.5", "name": "Composer 2.5" }
            ]
        })
    }

    fn fast(current: &str) -> Value {
        json!({
            "id": "fast", "name": "Fast", "category": "model_config", "type": "select",
            "currentValue": current,
            "options": [{ "value": "false", "name": "Off" }, { "value": "true", "name": "Fast" }]
        })
    }

    fn ids(options: &[Value]) -> Vec<&str> {
        options
            .iter()
            .map(|option| option["id"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn folds_companions_into_catalog_ids_and_appends_access() {
        let catalog = parse_models_output(
            "auto - Auto\ncomposer-2.5 - Composer 2.5 (current)\ncomposer-2.5-fast - Composer 2.5 Fast\n",
        );
        let mut config = SessionConfig::default();
        config.observe(&[mode(), model("composer-2.5"), fast("true")]);
        let options = config.host_options(&catalog, AccessMode::Default);
        assert_eq!(ids(&options), vec!["mode", "model", "access"]);
        assert_eq!(
            options[0]["options"][1]["_meta"]["cadencr"]["permissionMode"],
            "plan"
        );
        assert_eq!(options[2]["_meta"]["cadencr"]["role"], "access_mode");
        assert_eq!(options[1]["currentValue"], "composer-2.5-fast");
        assert_eq!(options[1]["options"][2]["value"], "composer-2.5-fast");
        assert_eq!(options[2]["currentValue"], "default");

        config.observe(&[fast("false")]);
        let options = config.host_options(&catalog, AccessMode::FullAccess);
        assert_eq!(options[1]["currentValue"], "composer-2.5");
        assert_eq!(options[2]["currentValue"], "full_access");

        config.applied_model = Some("auto".to_string());
        assert_eq!(
            config.host_options(&catalog, AccessMode::Default)[1]["currentValue"],
            "auto"
        );
    }

    #[test]
    fn model_snapshot_replaces_and_partial_updates_merge() {
        let mut config = SessionConfig::default();
        config.observe(&[mode(), model("composer-2.5"), fast("false")]);
        config.observe(&[mode(), model("default")]);
        assert!(config.model_state.companions("composer-2.5").is_empty());
        config.set_current("mode", json!("plan"));
        assert_eq!(config.mode().as_deref(), Some("plan"));
        config.observe(&[json!({ "id": "mode", "type": "select", "name": "Mode",
            "currentValue": "ask", "options": [{ "value": "ask", "name": "Ask" }] })]);
        assert_eq!(config.mode().as_deref(), Some("ask"));
        assert_eq!(config.host_options(&[], AccessMode::Default).len(), 3);
    }

    #[test]
    fn without_a_catalog_live_models_supply_the_choices() {
        let mut config = SessionConfig::default();
        config.observe(&[
            model("default"),
            json!({
                "id": "effort", "name": "Effort", "category": "thought_level", "type": "select",
                "currentValue": "high", "options": [{ "value": "high", "name": "High" }]
            }),
        ]);
        let options = config.host_options(&[], AccessMode::AutoReview);
        assert_eq!(ids(&options), vec!["model", "access"]);
        assert_eq!(options[0]["options"][0]["value"], "auto");
        assert_eq!(options[0]["currentValue"], "auto");
    }
}
