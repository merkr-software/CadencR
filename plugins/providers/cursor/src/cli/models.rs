//! Cursor's account-scoped model catalog (`agent models`).

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use cadencr_provider_sdk::ProviderError;
use serde_json::{json, Value};

const MODELS_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, bon::Builder)]
#[builder(on(String, into))]
pub struct CursorModel {
    pub id: String,
    pub label: String,
    #[builder(default)]
    pub is_current: bool,
}

pub async fn list_models(
    binary: &Path,
    cwd: Option<&Path>,
) -> Result<Vec<CursorModel>, ProviderError> {
    let output = super::run_captured(binary, &[OsString::from("models")], cwd, MODELS_TIMEOUT)
        .await
        .map_err(|error| discovery_error(&error.to_string()))?;
    if !output.status.success() {
        let tail = super::output_tail(&output, 400);
        return Err(discovery_error(&if tail.is_empty() {
            format!("`agent models` exited with {}", output.status)
        } else {
            tail
        }));
    }
    let models = parse_models_output(&String::from_utf8_lossy(&output.stdout));
    if models.is_empty() {
        return Err(discovery_error(
            "`agent models` returned no parseable models",
        ));
    }
    Ok(models)
}

fn discovery_error(detail: &str) -> ProviderError {
    ProviderError::new(format!(
        "Cursor model discovery failed; run `agent login` if you are signed out: {detail}"
    ))
}

/// Parse Cursor's model list. Current builds print one entry per line as
/// `<id> - <label>` and suffix the selected entry with `(current)`.
/// Unknown/noise lines are ignored so additions around the table remain
/// backward-compatible.
pub fn parse_models_output(output: &str) -> Vec<CursorModel> {
    output.lines().filter_map(parse_model_line).collect()
}

fn parse_model_line(line: &str) -> Option<CursorModel> {
    let clean = strip_ansi(line);
    let (raw_id, raw_label) = clean.trim().split_once(" - ")?;
    let id = raw_id
        .trim()
        .trim_start_matches(['*', '>', '-', '•'])
        .trim();
    if id.is_empty() || id.chars().any(char::is_whitespace) {
        return None;
    }
    let label = raw_label.replace("(current)", "").trim().to_string();
    if label.is_empty() {
        return None;
    }
    Some(
        CursorModel::builder()
            .id(id)
            .label(label)
            .is_current(raw_label.contains("(current)"))
            .build(),
    )
}

fn strip_ansi(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            output.push(ch);
            continue;
        }
        if chars.next() != Some('[') {
            continue;
        }
        for code in chars.by_ref() {
            if code.is_ascii_alphabetic() {
                break;
            }
        }
    }
    output
}

/// The `(current)` catalog entry, else the first one.
pub fn default_model_id(models: &[CursorModel]) -> Option<&str> {
    models
        .iter()
        .find(|model| model.is_current)
        .or_else(|| models.first())
        .map(|model| model.id.as_str())
}

/// The single `model` select both `models` discovery and the live session
/// advertise: values are cold catalog ids, so the host's pre-session choice is
/// always present in the live selector.
pub fn model_select_option(entries: &[(String, String)], current: &str) -> Value {
    let options: Vec<Value> = entries
        .iter()
        .map(|(id, label)| json!({ "value": id, "name": label }))
        .collect();
    json!({
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": current,
        "options": options,
    })
}

pub fn catalog_entries(models: &[CursorModel]) -> Vec<(String, String)> {
    models
        .iter()
        .map(|model| (model.id.clone(), model.label.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        catalog_entries, default_model_id, model_select_option, parse_models_output, CursorModel,
    };
    use agent_client_protocol::schema::v1::SessionConfigOption;

    #[test]
    fn parses_cursor_model_table_and_current_marker() {
        let models = parse_models_output(
            "auto - Auto  (current)\ncomposer-2-fast - Composer 2 Fast\ngpt-5.3-codex-high - GPT-5.3 Codex High\n",
        );
        assert_eq!(
            models,
            vec![
                CursorModel::builder()
                    .id("auto")
                    .label("Auto")
                    .is_current(true)
                    .build(),
                CursorModel::builder()
                    .id("composer-2-fast")
                    .label("Composer 2 Fast")
                    .build(),
                CursorModel::builder()
                    .id("gpt-5.3-codex-high")
                    .label("GPT-5.3 Codex High")
                    .build(),
            ]
        );
        assert_eq!(default_model_id(&models), Some("auto"));
    }

    #[test]
    fn ignores_headers_and_strips_ansi() {
        let models = parse_models_output(
            "Available models:\n\u{1b}[32m> auto - Auto (current)\u{1b}[0m\nnot a model\n",
        );
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "auto");
        assert_eq!(models[0].label, "Auto");
    }

    #[test]
    fn default_falls_back_to_the_first_entry() {
        let models = parse_models_output("composer-2 - Composer 2\nauto - Auto\n");
        assert_eq!(default_model_id(&models), Some("composer-2"));
        assert_eq!(default_model_id(&[]), None);
    }

    #[test]
    fn discovery_option_is_a_valid_model_select() {
        let models = parse_models_output("auto - Auto\ncomposer-2 - Composer 2 (current)\n");
        let value = model_select_option(&catalog_entries(&models), "composer-2");
        let option: SessionConfigOption = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(option.id.0.as_ref(), "model");
        assert_eq!(value["category"], "model");
        assert_eq!(value["currentValue"], "composer-2");
        assert_eq!(value["options"][1]["name"], "Composer 2");
    }
}
