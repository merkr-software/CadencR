//! Cursor ACP model / parameter mapping for parameterized model picker mode.
//!
//! With `clientCapabilities._meta.parameterizedModelPicker`, Cursor advertises
//! clean model ids plus separate `fast` / thought-level config options instead
//! of opaque values like `composer-2.5[fast=true]`. Cadencr's cold catalog still
//! lists variant ids (`composer-2.5-fast`, `gpt-5.3-codex-high`); this module
//! translates those into base model + companion config updates.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    SessionConfigSelectOptions,
};

use crate::domain::agents::acp::runtime::thought_level::is_thought_level_config_name;
use crate::domain::agents::adapter::RuntimeSessionConfigValue;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CatalogModelParts {
    pub base: String,
    pub fast: Option<bool>,
    pub effort: Option<String>,
    pub thinking: Option<bool>,
}

#[derive(Debug, Default)]
pub(super) struct CursorModelConfigState {
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
    fn value(self, value: bool) -> RuntimeSessionConfigValue {
        match self {
            Self::Select => RuntimeSessionConfigValue::Select(value.to_string()),
            Self::Boolean => RuntimeSessionConfigValue::Boolean(value),
        }
    }
}

impl CursorModelConfigState {
    /// Merge advertised options. A partial `configOptions` update only clears
    /// the fields it replaces, so it does not wipe unrelated caches.
    ///
    /// A payload carrying the `model` option is different — it is the agent's
    /// full snapshot for that model: Cursor answers `set_config_option(model=…)` with `mode`,
    /// `model`, and only the companions the new model supports (`default` has
    /// no `fast`). Companions it omits no longer exist, and setting one fails
    /// the spawn with "Unknown model config option".
    pub(super) fn observe(&mut self, options: &[SessionConfigOption]) {
        let saw_model = options.iter().any(|option| {
            matches!(option.category, Some(SessionConfigOptionCategory::Model))
                && option.id.0.as_ref() == "model"
        });
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
                Some(SessionConfigOptionCategory::ModelConfig) if id == "fast" => {
                    self.record_fast_option(option);
                }
                Some(SessionConfigOptionCategory::ThoughtLevel) => {
                    self.record_thought_level_option(option);
                }
                _ => {
                    if id == "fast" {
                        self.record_fast_option(option);
                    }
                }
            }
        }
    }

    pub(super) fn model_config_value(&self, model: &str) -> String {
        let parts = parse_catalog_model(model);
        self.model_config_value_for_parts(model, &parts)
    }

    pub(super) fn companions(&self, model: &str) -> Vec<(String, RuntimeSessionConfigValue)> {
        self.companions_for_parts(&parse_catalog_model(model))
    }

    pub(super) fn thinking_effort_config_id(&self) -> Option<String> {
        self.thought_level_config_id.clone()
    }

    fn model_config_value_for_parts(&self, model: &str, parts: &CatalogModelParts) -> String {
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
        parts.base.clone()
    }

    fn companions_for_parts(
        &self,
        parts: &CatalogModelParts,
    ) -> Vec<(String, RuntimeSessionConfigValue)> {
        let mut companions = Vec::new();
        if let Some(kind) = self.fast_option_kind {
            let fast = parts.fast.unwrap_or(false);
            companions.push(("fast".to_string(), kind.value(fast)));
        }
        if let (Some((config_id, kind)), Some(thinking)) =
            (self.thinking_config.as_ref(), parts.thinking)
        {
            companions.push((config_id.clone(), kind.value(thinking)));
        }
        if let (Some(config_id), Some(effort)) =
            (self.thought_level_config_id.as_ref(), parts.effort.as_ref())
        {
            companions.push((
                config_id.clone(),
                RuntimeSessionConfigValue::Select(effort.clone()),
            ));
        }
        companions
    }

    fn record_model_option(&mut self, option: &SessionConfigOption) {
        for_each_select_option(option, |select| {
            let value = select.value.0.to_string();
            let normalized_value = normalized_model_ref(&value);
            self.model_values
                .insert(normalized_model_ref(&select.name), value.clone());
            self.model_values
                .insert(normalized_value.clone(), value.clone());
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

pub(super) fn lock_mutex<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn catalog_model_encodes_effort(model: &str) -> bool {
    parse_catalog_model(model).effort.is_some()
}

pub(super) fn parse_catalog_model(model: &str) -> CatalogModelParts {
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
        let suffix = format!("-{token}");
        if let Some(stripped) = rest.strip_suffix(&suffix) {
            rest = stripped.to_string();
            effort = Some(if token == "extra-high" {
                "xhigh".to_string()
            } else {
                token.to_string()
            });
            break;
        }
    }

    if fast.is_none() {
        // Explicit non-fast catalog ids should turn Fast off when the option
        // exists, so selecting Composer 2.5 does not leave a prior Fast=on.
        fast = Some(false);
    }

    CatalogModelParts {
        base: rest,
        fast,
        effort,
        thinking,
    }
}

fn for_each_select_option(
    option: &SessionConfigOption,
    mut f: impl FnMut(&SessionConfigSelectOption),
) {
    let SessionConfigKind::Select(select) = &option.kind else {
        return;
    };
    match &select.options {
        SessionConfigSelectOptions::Ungrouped(options) => {
            for option in options {
                f(option);
            }
        }
        SessionConfigSelectOptions::Grouped(groups) => {
            for group in groups {
                for option in &group.options {
                    f(option);
                }
            }
        }
        _ => {}
    }
}

fn select_values(option: &SessionConfigOption) -> Vec<String> {
    let mut values = Vec::new();
    for_each_select_option(option, |select| {
        values.push(select.value.0.to_string());
    });
    values
}

fn normalized_model_ref(model: &str) -> String {
    model.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{parse_catalog_model, CursorModelConfigState};
    use crate::domain::agents::adapter::RuntimeSessionConfigValue;
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };

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
        let fast = SessionConfigOption::select(
            "fast",
            "Fast",
            "true",
            vec![
                SessionConfigSelectOption::new("false", "Off"),
                SessionConfigSelectOption::new("true", "Fast"),
            ],
        )
        .category(SessionConfigOptionCategory::ModelConfig);
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
        state.observe(&[model, fast, effort]);

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
            vec![(
                "fast".to_string(),
                RuntimeSessionConfigValue::Select("false".to_string())
            )]
        );
        assert_eq!(
            state.companions("composer-2.5-fast"),
            vec![(
                "fast".to_string(),
                RuntimeSessionConfigValue::Select("true".to_string())
            )]
        );
        assert_eq!(
            state.companions("cursor-grok-4.5-high"),
            vec![
                (
                    "fast".to_string(),
                    RuntimeSessionConfigValue::Select("false".to_string())
                ),
                (
                    "effort".to_string(),
                    RuntimeSessionConfigValue::Select("high".to_string())
                ),
            ]
        );
        assert_eq!(state.thinking_effort_config_id().as_deref(), Some("effort"));
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

        let fast = SessionConfigOption::select(
            "fast",
            "Fast",
            "false",
            vec![
                SessionConfigSelectOption::new("false", "Off"),
                SessionConfigSelectOption::new("true", "Fast"),
            ],
        )
        .category(SessionConfigOptionCategory::ModelConfig);
        state.observe(&[fast]);
        assert_eq!(state.model_config_value("composer-2.5"), "composer-2.5");
        assert_eq!(
            state.companions("composer-2.5"),
            vec![(
                "fast".to_string(),
                RuntimeSessionConfigValue::Select("false".to_string())
            )]
        );
    }

    #[test]
    fn switching_to_a_model_without_companions_stops_sending_them() {
        // Real Cursor sequence: `session/new` advertises `fast` for the
        // default composer model, but the `set_config_option(model=default)`
        // response lists only `mode` + `model`. Sending the stale `fast` then
        // fails the whole spawn ("Unknown model config option: fast").
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
        let fast = SessionConfigOption::select(
            "fast",
            "Fast",
            "false",
            vec![
                SessionConfigSelectOption::new("false", "Off"),
                SessionConfigSelectOption::new("true", "Fast"),
            ],
        )
        .category(SessionConfigOptionCategory::ModelConfig);
        let effort = SessionConfigOption::select(
            "effort",
            "Effort",
            "high",
            vec![SessionConfigSelectOption::new("high", "High")],
        )
        .category(SessionConfigOptionCategory::ThoughtLevel);
        state.observe(&[model("composer-2.5"), fast.clone(), effort]);

        state.observe(&[model("default")]);
        assert!(state.companions("auto").is_empty());
        assert!(state.companions("cursor-grok-4.5-high").is_empty());
        assert!(state.thinking_effort_config_id().is_none());

        // Switching back to a model that has `fast` re-advertises it.
        state.observe(&[model("composer-2.5"), fast]);
        assert_eq!(
            state.companions("composer-2.5-fast"),
            vec![(
                "fast".to_string(),
                RuntimeSessionConfigValue::Select("true".to_string())
            )]
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
            vec![(
                "thinking".to_string(),
                RuntimeSessionConfigValue::Boolean(true)
            )]
        );
        assert!(state.thinking_effort_config_id().is_none());
    }

    #[test]
    fn boolean_fast_option_stays_boolean() {
        let mut state = CursorModelConfigState::default();
        state.observe(&[SessionConfigOption::boolean("fast", "Fast", false)
            .category(SessionConfigOptionCategory::ModelConfig)]);

        assert_eq!(
            state.companions("composer-2.5-fast"),
            vec![("fast".to_string(), RuntimeSessionConfigValue::Boolean(true))]
        );
    }
}
