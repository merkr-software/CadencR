use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};

use agent_client_protocol::schema::v1::{
    Meta, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
};
use cadencr_provider_sdk::{run_cli, CadencrProvider, ProviderError};
use serde::Deserialize;
use serde_json::{json, Value};

const MODELS_REQUEST_ID: &str = "cadencr-models";
const STATE_REQUEST_ID: &str = "cadencr-state";

struct PiProvider;

impl CadencrProvider for PiProvider {
    fn models(
        &self,
        cwd: &Path,
        _provider_args: &[OsString],
    ) -> Result<Vec<SessionConfigOption>, ProviderError> {
        discover_pi_models(cwd)
    }

    fn run_acp(&self, provider_args: &[OsString]) -> Result<ExitCode, ProviderError> {
        let binary = std::env::var_os("CADENCR_PI_ACP_PATH").unwrap_or_else(|| "pi-acp".into());
        let status = Command::new(binary)
            .args(provider_args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()?;
        Ok(status
            .code()
            .and_then(|code| u8::try_from(code).ok())
            .map(ExitCode::from)
            .unwrap_or(ExitCode::FAILURE))
    }

    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }
}

fn main() -> ExitCode {
    run_cli(&PiProvider)
}

fn discover_pi_models(cwd: &Path) -> Result<Vec<SessionConfigOption>, ProviderError> {
    let binary = std::env::var_os("CADENCR_PI_PATH").unwrap_or_else(|| "pi".into());
    let mut child = Command::new(binary)
        .args(["--mode", "rpc", "--no-session"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ProviderError::new("Pi RPC stdin unavailable"))?;
    writeln!(
        stdin,
        "{}",
        json!({ "id": MODELS_REQUEST_ID, "type": "get_available_models" })
    )?;
    writeln!(
        stdin,
        "{}",
        json!({ "id": STATE_REQUEST_ID, "type": "get_state" })
    )?;
    drop(stdin);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ProviderError::new("Pi RPC stdout unavailable"))?;
    let responses = collect_responses(BufReader::new(stdout))?;
    let status = child.wait()?;
    if !status.success() {
        return Err(ProviderError::new(format!(
            "Pi RPC model discovery exited with {status}"
        )));
    }
    let models = parse_models_response(responses.get(MODELS_REQUEST_ID))?;
    let current = parse_current_model(responses.get(STATE_REQUEST_ID));
    build_model_option(models, current)
}

fn collect_responses(reader: impl BufRead) -> Result<HashMap<String, Value>, ProviderError> {
    let mut responses = HashMap::new();
    for line in reader.lines() {
        let line = line?;
        let value: Value = serde_json::from_str(&line)?;
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        if matches!(id, MODELS_REQUEST_ID | STATE_REQUEST_ID) {
            responses.insert(id.to_string(), value);
        }
    }
    Ok(responses)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiModel {
    provider: String,
    id: String,
    #[serde(default)]
    name: Option<String>,
    context_window: u64,
    reasoning: bool,
}

fn parse_models_response(value: Option<&Value>) -> Result<Vec<PiModel>, ProviderError> {
    let value = value.ok_or_else(|| ProviderError::new("Pi omitted get_available_models"))?;
    if value.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(ProviderError::new("Pi get_available_models failed"));
    }
    let models = value
        .pointer("/data/models")
        .cloned()
        .ok_or_else(|| ProviderError::new("Pi model response omitted data.models"))?;
    let models: Vec<PiModel> = serde_json::from_value(models)?;
    if models.is_empty() {
        return Err(ProviderError::new("Pi returned no configured models"));
    }
    Ok(models)
}

fn parse_current_model(value: Option<&Value>) -> Option<String> {
    let model = value?.pointer("/data/model")?;
    let provider = model.get("provider")?.as_str()?.trim();
    let id = model.get("id")?.as_str()?.trim();
    (!provider.is_empty() && !id.is_empty()).then(|| format!("{provider}/{id}"))
}

fn build_model_option(
    models: Vec<PiModel>,
    current: Option<String>,
) -> Result<Vec<SessionConfigOption>, ProviderError> {
    let choices: Vec<SessionConfigSelectOption> = models
        .into_iter()
        .map(|model| {
            let id = format!("{}/{}", model.provider, model.id);
            let label = format!(
                "{}: {}",
                model.provider,
                model.name.as_deref().unwrap_or(&model.id)
            );
            let mut cadencr = Meta::new();
            cadencr.insert("supportsEffort".to_string(), json!(model.reasoning));
            let mut meta = Meta::new();
            meta.insert("cadencr".to_string(), Value::Object(cadencr));
            SessionConfigSelectOption::new(id, label)
                .description(format!("{} token context window", model.context_window))
                .meta(meta)
        })
        .collect();
    let current = current
        .filter(|current| {
            choices
                .iter()
                .any(|choice| choice.value.0.as_ref() == current)
        })
        .unwrap_or_else(|| choices[0].value.0.to_string());
    Ok(vec![SessionConfigOption::select(
        "model", "Model", current, choices,
    )
    .category(SessionConfigOptionCategory::Model)
    .description("Select the Pi model before starting a session")])
}

#[cfg(test)]
mod tests {
    use super::{build_model_option, PiModel};
    use agent_client_protocol::schema::v1::SessionConfigKind;

    #[test]
    fn pi_models_use_the_same_ids_as_pi_acp() {
        let options = build_model_option(
            vec![PiModel {
                provider: "anthropic".to_string(),
                id: "claude-opus".to_string(),
                name: Some("Claude Opus".to_string()),
                context_window: 200_000,
                reasoning: true,
            }],
            Some("anthropic/claude-opus".to_string()),
        )
        .unwrap();
        let SessionConfigKind::Select(select) = &options[0].kind else {
            panic!("model option must be select")
        };
        assert_eq!(select.current_value.0.as_ref(), "anthropic/claude-opus");
        let serialized = serde_json::to_value(&options).unwrap();
        assert_eq!(
            serialized[0]["options"][0]["value"],
            "anthropic/claude-opus"
        );
        assert_eq!(
            serialized[0]["options"][0]["_meta"]["cadencr"]["supportsEffort"],
            true
        );
    }
}
