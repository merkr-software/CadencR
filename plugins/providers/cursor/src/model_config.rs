//! Cursor ACP model / parameter mapping for parameterized model picker mode.
//!
//! With `clientCapabilities._meta.parameterizedModelPicker`, Cursor advertises
//! clean model ids plus separate `fast` / thought-level config options instead
//! of opaque values like `composer-2.5[fast=true]`. The cold `agent models`
//! catalog still lists variant ids (`composer-2.5-fast`, `gpt-5.3-codex-high`);
//! this module translates those into base model + companion config updates.

use std::collections::HashMap;

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    SessionConfigSelectOptions,
};
use serde_json::Value;

/// A companion `session/set_config_option` value sent to Cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompanionValue {
    Select(String),
    Boolean(bool),
}

impl CompanionValue {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Select(value) => Value::String(value.clone()),
            Self::Boolean(value) => Value::Bool(*value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogModelParts {
    pub base: String,
    pub fast: Option<bool>,
    pub effort: Option<String>,
    pub thinking: Option<bool>,
}

#[derive(Debug, Default, Clone)]
pub struct CursorModelConfigState {
    model_values: HashMap<String, String>,
    fast_option_kind: Option<CompanionValueKind>,
    thought_level_config_id: Option<String>,
    thinking_config: Option<(String, CompanionValueKind)>,
}

#[derive(Debug, Clone, Copy)]
enum CompanionValueKind {
    Select,
    Boolean,
}

impl CompanionValueKind {
    fn value(self, value: bool) -> CompanionValue {
        match self {
            Self::Select => CompanionValue::Select(value.to_string()),
            Self::Boolean => CompanionValue::Boolean(value),
        }
    }
}

/// Config ids Cadencr historically treated as a thought-level selector.
pub fn is_thought_level_config_name(name: &str) -> bool {
    matches!(
        name,
        "thinkingEffort" | "effort" | "reasoning" | "thought_level"
    )
}

impl CursorModelConfigState {
    /// Merge advertised options. A partial `configOptions` update only clears
    /// the fields it replaces, so it does not wipe unrelated caches.
    ///
    /// A payload carrying the `model` option is different — it is the agent's
    /// full snapshot for that model: Cursor answers `set_config_option(model=…)`
    /// with `mode`, `model`, and only the companions the new model supports
    /// (`default` has no `fast`). Companions it omits no longer exist, and
    /// setting one fails with "Unknown model config option".
    pub fn observe(&mut self, options: &[SessionConfigOption]) {
        let saw_model = options.iter().any(is_model_option);
        let saw_fast = options.iter().any(|option| option.id.0.as_ref() == "fast");
        let saw_thought = options.iter().any(|option| {
            matches!(
                option.category,
                Some(SessionConfigOptionCategory::ThoughtLevel)
            )
        });

        if saw_model {
            self.model_values.clear();
        }
        if saw_model || saw_fast {
            self.fast_option_kind = None;
        }
        if saw_model || saw_thought {
            self.thought_level_config_id = None;
            self.thinking_config = None;
        }

        for option in options {
            let id = option.id.0.as_ref();
            match option.category {
                Some(SessionConfigOptionCategory::Model) if id == "model" => {
                    self.record_model_option(option);
                }
                Some(SessionConfigOptionCategory::ThoughtLevel) => {
                    self.record_thought_level_option(option);
                }
                _ if id == "fast" => self.record_fast_option(option),
                _ => {}
            }
        }
    }

    pub fn model_config_value(&self, model: &str) -> String {
        let parts = parse_catalog_model(model);
        let candidates = [
            normalized_model_ref(&parts.base),
            normalized_model_ref(model),
            normalized_model_ref(parts.base.trim_start_matches("cursor-")),
        ];
        for candidate in candidates {
            if let Some(value) = self.model_values.get(&candidate) {
                return value.clone();
            }
        }
        if parts.base == "auto" {
            return "default".to_string();
        }
        parts.base
    }

    pub fn companions(&self, model: &str) -> Vec<(String, CompanionValue)> {
        let parts = parse_catalog_model(model);
        let mut companions = Vec::new();
        if let Some(kind) = self.fast_option_kind {
            companions.push(("fast".to_string(), kind.value(parts.fast.unwrap_or(false))));
        }
        if let (Some((config_id, kind)), Some(thinking)) =
            (self.thinking_config.as_ref(), parts.thinking)
        {
            companions.push((config_id.clone(), kind.value(thinking)));
        }
        if let (Some(config_id), Some(effort)) =
            (self.thought_level_config_id.as_ref(), parts.effort)
        {
            companions.push((config_id.clone(), CompanionValue::Select(effort)));
        }
        companions
    }

    /// Ids of the companion options this state folds into catalog model ids.
    pub fn is_companion_id(&self, id: &str) -> bool {
        id == "fast"
            || self.thought_level_config_id.as_deref() == Some(id)
            || self
                .thinking_config
                .as_ref()
                .is_some_and(|(config_id, _)| config_id == id)
    }

    fn record_model_option(&mut self, option: &SessionConfigOption) {
        for_each_select_option(option, |select| {
            let value = select.value.0.to_string();
            self.model_values
                .insert(normalized_model_ref(&select.name), value.clone());
            self.model_values
                .insert(normalized_model_ref(&value), value.clone());
            // Keep aliases for opaque variants-mode values if an older agent
            // still advertises them.
            if value.contains("fast=true") {
                self.model_values.insert(
                    normalized_model_ref(&format!("{}-fast", select.name)),
                    value.clone(),
                );
            }
            if let Some(base) = value.split('[').next() {
                self.model_values
                    .insert(normalized_model_ref(base), value.clone());
            }
        });
    }

    fn record_fast_option(&mut self, option: &SessionConfigOption) {
        self.fast_option_kind = Some(match option.kind {
            SessionConfigKind::Boolean(_) => CompanionValueKind::Boolean,
            _ => CompanionValueKind::Select,
        });
    }

    fn record_thought_level_option(&mut self, option: &SessionConfigOption) {
        let id = option.id.0.to_string();
        if matches!(option.kind, SessionConfigKind::Boolean(_)) {
            self.thinking_config = Some((id, CompanionValueKind::Boolean));
            return;
        }
        let values = select_values(option);
        let boolean_only = !values.is_empty()
            && values
                .iter()
                .all(|value| matches!(value.as_str(), "true" | "false"));
        if boolean_only {
            self.thinking_config = Some((id, CompanionValueKind::Select));
            return;
        }
        let preferred = is_thought_level_config_name(&id);
        if preferred || self.thought_level_config_id.is_none() {
            self.thought_level_config_id = Some(id);
        }
    }
}

pub fn is_model_option(option: &SessionConfigOption) -> bool {
    matches!(option.category, Some(SessionConfigOptionCategory::Model))
        && option.id.0.as_ref() == "model"
}

pub fn parse_catalog_model(model: &str) -> CatalogModelParts {
    let mut rest = normalized_model_ref(model);
    if rest == "auto" {
        return CatalogModelParts {
            base: "auto".to_string(),
            fast: None,
            effort: None,
            thinking: None,
        };
    }

    let mut fast = None;
    if let Some(stripped) = rest.strip_suffix("-fast") {
        rest = stripped.to_string();
        fast = Some(true);
    }

    let mut thinking = None;
    if let Some(idx) = rest.find("-thinking-") {
        let (prefix, suffix) = rest.split_at(idx);
        rest = format!("{prefix}{}", &suffix["-thinking".len()..]);
        thinking = Some(true);
    } else if let Some(stripped) = rest.strip_suffix("-thinking") {
        rest = stripped.to_string();
        thinking = Some(true);
    }

    let mut effort = None;
    for token in ["xhigh", "extra-high", "medium", "high", "low", "max"] {
        if let Some(stripped) = rest.strip_suffix(&format!("-{token}")) {
            rest = stripped.to_string();
            effort = Some(
                if token == "extra-high" {
                    "xhigh"
                } else {
                    token
                }
                .to_string(),
            );
            break;
        }
    }

    CatalogModelParts {
        base: rest,
        // Explicit non-fast catalog ids turn Fast off when the option exists,
        // so selecting Composer 2.5 does not leave a prior Fast=on.
        fast: Some(fast.unwrap_or(false)),
        effort,
        thinking,
    }
}

pub fn for_each_select_option(
    option: &SessionConfigOption,
    mut f: impl FnMut(&SessionConfigSelectOption),
) {
    let SessionConfigKind::Select(select) = &option.kind else {
        return;
    };
    match &select.options {
        SessionConfigSelectOptions::Ungrouped(options) => options.iter().for_each(&mut f),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .for_each(&mut f),
        _ => {}
    }
}

fn select_values(option: &SessionConfigOption) -> Vec<String> {
    let mut values = Vec::new();
    for_each_select_option(option, |select| values.push(select.value.0.to_string()));
    values
}

fn normalized_model_ref(model: &str) -> String {
    model.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{parse_catalog_model, CompanionValue, CursorModelConfigState};
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };

    fn select(value: &str) -> CompanionValue {
        CompanionValue::Select(value.to_string())
    }

    fn fast(current: &'static str) -> SessionConfigOption {
        SessionConfigOption::select(
            "fast",
            "Fast",
            current,
            vec![
                SessionConfigSelectOption::new("false", "Off"),
                SessionConfigSelectOption::new("true", "Fast"),
            ],
        )
        .category(SessionConfigOptionCategory::ModelConfig)
    }

    #[test]
    fn parses_catalog_variants() {
        let composer = parse_catalog_model("composer-2.5");
        assert_eq!(composer.base, "composer-2.5");
        assert_eq!(composer.fast, Some(false));
        assert!(composer.effort.is_none());

        let fast = parse_catalog_model("composer-2.5-fast");
        assert_eq!(fast.base, "composer-2.5");
        assert_eq!(fast.fast, Some(true));

        let high_fast = parse_catalog_model("gpt-5.3-codex-high-fast");
        assert_eq!(high_fast.base, "gpt-5.3-codex");
        assert_eq!(high_fast.fast, Some(true));
        assert_eq!(high_fast.effort.as_deref(), Some("high"));

        let thinking = parse_catalog_model("claude-opus-4-8-thinking-high");
        assert_eq!(thinking.base, "claude-opus-4-8");
        assert_eq!(thinking.thinking, Some(true));
        assert_eq!(thinking.effort.as_deref(), Some("high"));
        assert_eq!(thinking.fast, Some(false));

        let extra = parse_catalog_model("gpt-5-extra-high");
        assert_eq!(extra.effort.as_deref(), Some("xhigh"));
        assert_eq!(parse_catalog_model("AUTO").base, "auto");
    }

    #[test]
    fn parameterized_options_map_catalog_ids_without_forcing_fast() {
        let mut state = CursorModelConfigState::default();
        let model = SessionConfigOption::select(
            "model",
            "Model",
            "composer-2.5",
            vec![
                SessionConfigSelectOption::new("default", "Auto"),
                SessionConfigSelectOption::new("composer-2.5", "Composer 2.5"),
                SessionConfigSelectOption::new("grok-4.5", "Cursor Grok 4.5"),
            ],
        )
        .category(SessionConfigOptionCategory::Model);
        let effort = SessionConfigOption::select(
            "effort",
            "Effort",
            "high",
            vec![
                SessionConfigSelectOption::new("low", "Low"),
                SessionConfigSelectOption::new("high", "High"),
            ],
        )
        .category(SessionConfigOptionCategory::ThoughtLevel);
        state.observe(&[model, fast("true"), effort]);

        assert_eq!(state.model_config_value("auto"), "default");
        assert_eq!(state.model_config_value("composer-2.5"), "composer-2.5");
        assert_eq!(
            state.model_config_value("composer-2.5-fast"),
            "composer-2.5"
        );
        assert_eq!(
            state.model_config_value("cursor-grok-4.5-high-fast"),
            "grok-4.5"
        );
        assert_eq!(
            state.companions("composer-2.5"),
            vec![("fast".to_string(), select("false"))]
        );
        assert_eq!(
            state.companions("composer-2.5-fast"),
            vec![("fast".to_string(), select("true"))]
        );
        assert_eq!(
            state.companions("cursor-grok-4.5-high"),
            vec![
                ("fast".to_string(), select("false")),
                ("effort".to_string(), select("high")),
            ]
        );
        assert!(state.is_companion_id("effort"));
        assert!(state.is_companion_id("fast"));
        assert!(!state.is_companion_id("mode"));
    }

    #[test]
    fn observe_partial_fast_update_keeps_model_map() {
        let mut state = CursorModelConfigState::default();
        let model = SessionConfigOption::select(
            "model",
            "Model",
            "composer-2.5",
            vec![SessionConfigSelectOption::new(
                "composer-2.5",
                "Composer 2.5",
            )],
        )
        .category(SessionConfigOptionCategory::Model);
        state.observe(&[model]);
        assert_eq!(state.model_config_value("composer-2.5"), "composer-2.5");

        state.observe(&[fast("false")]);
        assert_eq!(state.model_config_value("composer-2.5"), "composer-2.5");
        assert_eq!(
            state.companions("composer-2.5"),
            vec![("fast".to_string(), select("false"))]
        );
    }

    #[test]
    fn switching_to_a_model_without_companions_stops_sending_them() {
        // Real Cursor sequence: `session/new` advertises `fast` for the
        // default composer model, but the `set_config_option(model=default)`
        // response lists only `mode` + `model`. Sending the stale `fast` then
        // fails ("Unknown model config option: fast").
        let mut state = CursorModelConfigState::default();
        let model = |current: &'static str| {
            SessionConfigOption::select(
                "model",
                "Model",
                current,
                vec![
                    SessionConfigSelectOption::new("default", "Auto"),
                    SessionConfigSelectOption::new("composer-2.5", "Composer 2.5"),
                ],
            )
            .category(SessionConfigOptionCategory::Model)
        };
        let effort = SessionConfigOption::select(
            "effort",
            "Effort",
            "high",
            vec![SessionConfigSelectOption::new("high", "High")],
        )
        .category(SessionConfigOptionCategory::ThoughtLevel);
        state.observe(&[model("composer-2.5"), fast("false"), effort]);

        state.observe(&[model("default")]);
        assert!(state.companions("auto").is_empty());
        assert!(state.companions("cursor-grok-4.5-high").is_empty());

        // Switching back to a model that has `fast` re-advertises it.
        state.observe(&[model("composer-2.5"), fast("false")]);
        assert_eq!(
            state.companions("composer-2.5-fast"),
            vec![("fast".to_string(), select("true"))]
        );
    }

    #[test]
    fn boolean_thought_level_option_stays_boolean() {
        let mut state = CursorModelConfigState::default();
        state.observe(
            &[SessionConfigOption::boolean("thinking", "Thinking", false)
                .category(SessionConfigOptionCategory::ThoughtLevel)],
        );
        assert_eq!(
            state.companions("claude-opus-4-8-thinking"),
            vec![("thinking".to_string(), CompanionValue::Boolean(true))]
        );
        assert!(state.is_companion_id("thinking"));
    }

    #[test]
    fn boolean_fast_option_stays_boolean() {
        let mut state = CursorModelConfigState::default();
        state.observe(&[SessionConfigOption::boolean("fast", "Fast", false)
            .category(SessionConfigOptionCategory::ModelConfig)]);
        assert_eq!(
            state.companions("composer-2.5-fast"),
            vec![("fast".to_string(), CompanionValue::Boolean(true))]
        );
        assert_eq!(
            CompanionValue::Boolean(true).to_json(),
            serde_json::json!(true)
        );
    }
}
