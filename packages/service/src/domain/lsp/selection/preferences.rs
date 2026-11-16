//! Field-wise preference inheritance and bounded compatibility with prior saved settings.
use crate::error::AppError;
use serde_json::Value;
use std::collections::BTreeMap;
pub(super) struct Preferences {
    pub primary_value: Option<Value>,
    pub primary_disabled: bool,
    pub linters: Vec<String>,
    pub ignored: bool,
}
pub(super) fn read(
    language: &str,
    global: &BTreeMap<String, String>,
    project: &BTreeMap<String, String>,
) -> Result<Preferences, AppError> {
    let global_preferences = language_settings(global, language)?;
    let project_preferences = language_settings(project, language)?;
    let primary_value = project_preferences
        .get("primary")
        .cloned()
        .or_else(|| legacy_primary(project, language))
        .or_else(|| global_preferences.get("primary").cloned())
        .or_else(|| legacy_primary(global, language));
    let primary_disabled = primary_value
        .as_ref()
        .is_some_and(|value| value.is_null() || value.as_str() == Some("off"));
    let linters_value = project_preferences
        .get("linters")
        .cloned()
        .or_else(|| {
            project.get("editor_linter").map(|id| {
                if id == "off" {
                    serde_json::json!([])
                } else {
                    serde_json::json!([id])
                }
            })
        })
        .or_else(|| global_preferences.get("linters").cloned())
        .or_else(|| {
            global.get("editor_linter").map(|id| {
                if id == "off" {
                    serde_json::json!([])
                } else {
                    serde_json::json!([id])
                }
            })
        });
    let linters = linters_value
        .map(serde_json::from_value::<Vec<String>>)
        .transpose()
        .map_err(|error| AppError::BadRequest(format!("Invalid LSP linters: {error}")))?
        .unwrap_or_default();
    let ignored = legacy(global, project, "editor_lsp_ignored_languages")
        .map(|text| {
            serde_json::from_str::<Vec<String>>(text).map(|ids| ids.iter().any(|id| id == language))
        })
        .transpose()
        .map_err(|error| AppError::BadRequest(format!("Invalid ignored LSP languages: {error}")))?
        .unwrap_or(false);
    Ok(Preferences {
        primary_value,
        primary_disabled,
        linters,
        ignored,
    })
}
fn language_settings(map: &BTreeMap<String, String>, language: &str) -> Result<Value, AppError> {
    let Some(text) = map.get("editor_lsp_languages") else {
        return Ok(Value::Null);
    };
    let settings: Value = serde_json::from_str(text)
        .map_err(|error| AppError::BadRequest(format!("Invalid editor_lsp_languages: {error}")))?;
    Ok(settings[language].clone())
}
fn legacy_primary(map: &BTreeMap<String, String>, language: &str) -> Option<Value> {
    [
        "typescript",
        "typescriptreact",
        "javascript",
        "javascriptreact",
    ]
    .contains(&language)
    .then(|| {
        map.get("editor_typescript_server")
            .map(|id| Value::String(id.clone()))
    })
    .flatten()
}
fn legacy<'a>(
    global: &'a BTreeMap<String, String>,
    project: &'a BTreeMap<String, String>,
    key: &str,
) -> Option<&'a String> {
    project.get(key).or_else(|| global.get(key))
}
/// Validate dynamic ids and role fields without fixing the set of marketplace servers.
pub fn valid_preferences(text: &str) -> bool {
    let Ok(Value::Object(languages)) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    languages.iter().all(|(id, fields)| {
        !id.is_empty()
            && fields.as_object().is_some_and(|fields| {
                fields.iter().all(|(key, value)| match key.as_str() {
                    "primary" => {
                        value.is_null()
                            || value
                                .as_str()
                                .is_some_and(cadencr_registry_core::valid_theme_id)
                    }
                    "linters" => value.as_array().is_some_and(|ids| {
                        ids.iter().all(|id| {
                            id.as_str()
                                .is_some_and(cadencr_registry_core::valid_theme_id)
                        })
                    }),
                    _ => false,
                })
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_null_overrides_legacy_without_modifying_it() {
        let global = BTreeMap::from([("editor_typescript_server".into(), "tsgo".into())]);
        let project = BTreeMap::from([(
            "editor_lsp_languages".into(),
            r#"{"typescript":{"primary":null}}"#.into(),
        )]);
        let resolved = read("typescript", &global, &project).unwrap();
        assert!(resolved.primary_disabled);
        assert_eq!(resolved.primary_value, Some(Value::Null));
        assert_eq!(global["editor_typescript_server"], "tsgo");
    }
    #[test]
    fn project_fields_inherit_independently() {
        let global = BTreeMap::from([(
            "editor_lsp_languages".into(),
            r#"{"rust":{"primary":"analyzer","linters":["lint"]}}"#.into(),
        )]);
        let project = BTreeMap::from([(
            "editor_lsp_languages".into(),
            r#"{"rust":{"linters":[]}}"#.into(),
        )]);
        let result = read("rust", &global, &project).unwrap();
        assert_eq!(
            result.primary_value.as_ref().and_then(Value::as_str),
            Some("analyzer")
        );
        assert!(result.linters.is_empty());
    }
    #[test]
    fn project_legacy_choices_override_global_per_language_preferences() {
        let global = BTreeMap::from([(
            "editor_lsp_languages".into(),
            r#"{"typescript":{"primary":"global-server","linters":["global-linter"]}}"#.into(),
        )]);
        let project = BTreeMap::from([
            ("editor_typescript_server".into(), "tsgo".into()),
            ("editor_linter".into(), "off".into()),
        ]);
        let result = read("typescript", &global, &project).unwrap();
        assert_eq!(
            result.primary_value.as_ref().and_then(Value::as_str),
            Some("tsgo")
        );
        assert!(result.linters.is_empty());
    }
    #[test]
    fn preferences_allow_dynamic_ids_but_reject_unsupported_fields() {
        assert!(valid_preferences(
            r#"{"futurelang":{"primary":"custom-server","linters":["custom-lint"]}}"#
        ));
        assert!(!valid_preferences(r#"{"futurelang":{"command":"sh"}}"#));
        assert!(!valid_preferences(
            r#"{"futurelang":{"primary":"../escape"}}"#
        ));
        assert!(!valid_preferences(r#"{"futurelang":{"linters":[null]}}"#));
    }
}
