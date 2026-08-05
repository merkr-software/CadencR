//! One-shot CLI metadata probes that ride the `initialize` control
//! request — used to fetch the slash-command catalog and the model list
//! without billing a real query.
//!
//! Both helpers spawn the CLI, send `initialize`, read until the matching
//! `control_response` arrives, then kill the subprocess. The CLI's own
//! `initialize` round-trip (which it may interleave) is acknowledged so
//! the CLI doesn't stall waiting on us. The shared handshake lives in
//! [`run_initialize_probe`]; each helper supplies its own extractor for
//! the field it cares about (`commands` vs `models`).

use std::collections::HashMap;
use std::time::Duration;

use crate::discovery::find_cli;
use crate::error::SdkError;
use crate::options::Options;
use crate::transport::CliProcess;

use super::wire::{
    build_control_request, build_success_ack, control_request_subtype, write_to_stdin,
};

/// How long to wait for the CLI's `control_response` before declaring
/// the probe stalled. The handshake is local-only and usually completes
/// in milliseconds; this ceiling exists to avoid hanging the caller if
/// the CLI is wedged.
const INIT_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Send an `initialize` control_request and run a poll loop until the
/// matching `control_response` arrives, the CLI exits, or the timeout
/// fires. Acks any CLI-initiated `initialize` request along the way so
/// the CLI doesn't stall waiting on us.
///
/// `extract` is called with the inner `response` object (`/response/response`
/// from the raw envelope) and returns the typed value the caller wants.
/// Always kills the subprocess before returning.
async fn run_initialize_probe<T, F>(
    cwd: &str,
    path_to_cli: Option<&std::path::Path>,
    env: Option<HashMap<String, String>>,
    id_prefix: &str,
    extract: F,
) -> Result<T, SdkError>
where
    F: FnOnce(&serde_json::Value) -> Result<T, SdkError>,
{
    let cli_path = find_cli(path_to_cli).await?;

    let options = Options {
        cwd: std::path::PathBuf::from(cwd),
        env,
        ..Options::default()
    };

    let mut process = CliProcess::spawn(&cli_path, &options).await?;

    let stdin = process.take_stdin();
    let process_stdin = tokio::sync::Mutex::new(stdin);

    let (init_request_id, init_msg) =
        build_control_request(id_prefix, serde_json::json!({ "subtype": "initialize" }));
    write_to_stdin(&process_stdin, &init_msg).await?;

    let result = tokio::time::timeout(INIT_PROBE_TIMEOUT, async {
        loop {
            match process.read_message().await? {
                Some(raw) => {
                    // Match the control_response to our initialize request.
                    if raw.get("type").and_then(|t| t.as_str()) == Some("control_response") {
                        let req_id = raw.pointer("/response/request_id").and_then(|v| v.as_str());
                        if req_id == Some(init_request_id.as_str()) {
                            let inner = raw
                                .pointer("/response/response")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null);
                            return extract(&inner);
                        }
                        continue;
                    }
                    // The CLI may send its own `initialize` control_request;
                    // reply so it keeps going while we await our response.
                    if control_request_subtype(&raw) == Some("initialize") {
                        let request_id = raw
                            .get("request_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        write_to_stdin(&process_stdin, &build_success_ack(&request_id)).await?;
                        continue;
                    }
                    // Ignore any other messages (e.g. system.init emitted early).
                }
                None => {
                    let (code, stderr) = process.wait_with_stderr().await;
                    return Err(SdkError::ProcessExit { code, stderr });
                }
            }
        }
    })
    .await;

    let _ = process.kill().await;

    match result {
        Ok(r) => r,
        Err(_elapsed) => Err(SdkError::Timeout),
    }
}

/// Fetch slash commands via the `initialize` control-request — a pure local
/// metadata handshake (no prompt, no tokens). Returns [`SdkError::Timeout`]
/// if the CLI doesn't reply within 10 seconds. `argumentHint` is dropped:
/// [`SlashCommand`](crate::types::SlashCommand) doesn't carry it yet.
pub async fn supported_commands(
    cwd: &str,
    path_to_cli: Option<&std::path::Path>,
) -> Result<Vec<crate::types::SlashCommand>, SdkError> {
    run_initialize_probe(cwd, path_to_cli, None, "init_cmd", |response| {
        let commands = response
            .get("commands")
            .cloned()
            .unwrap_or(serde_json::Value::Array(Vec::new()));
        Ok(parse_supported_commands(&commands))
    })
    .await
}

/// Decode the `commands` array from the `initialize` control-response.
/// Non-array shapes yield an empty Vec so callers can apply their own
/// fallback (e.g. [`crate::commands::list_builtin_commands`]).
fn parse_supported_commands(commands: &serde_json::Value) -> Vec<crate::types::SlashCommand> {
    let Some(entries) = commands.as_array() else {
        tracing::warn!(
            "initialize control_response `commands` was not an array; treating as empty"
        );
        return Vec::new();
    };
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(name) = entry.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let description = entry
            .get("description")
            .and_then(|v| v.as_str())
            .filter(|d| !d.is_empty())
            .map(ToOwned::to_owned);
        out.push(crate::types::SlashCommand {
            name: name.to_string(),
            description,
        });
    }
    out
}

/// Fetch the list of models the CLI currently exposes.
///
/// Sends the `initialize` control-request over the CLI's stdin/stdout control
/// protocol and reads the matching `control_response` to extract `models`.
/// This is a pure local metadata handshake — no prompt is submitted, no tokens
/// are billed, and no network round-trip is required to fill the `models` field.
///
/// The CLI process is killed before returning.
///
/// # Timeout
///
/// If the CLI doesn't reply within 10 seconds, returns [`SdkError::Timeout`].
pub async fn supported_models(
    cwd: &str,
    path_to_cli: Option<&std::path::Path>,
) -> Result<Vec<crate::types::ModelInfo>, SdkError> {
    supported_models_with_env(cwd, path_to_cli, None).await
}

/// Fetch the list of models the CLI currently exposes with additional
/// environment variables layered onto the probe process.
///
/// This must be used when the host has a runtime profile that changes Claude
/// Code's provider backend (for example Bedrock or Vertex), because the CLI
/// resolves aliases and model metadata during initialize using its process
/// environment.
pub async fn supported_models_with_env(
    cwd: &str,
    path_to_cli: Option<&std::path::Path>,
    env: Option<HashMap<String, String>>,
) -> Result<Vec<crate::types::ModelInfo>, SdkError> {
    run_initialize_probe(cwd, path_to_cli, env, "init_models", |response| {
        let models = response
            .get("models")
            .cloned()
            .unwrap_or(serde_json::Value::Array(Vec::new()));
        serde_json::from_value(models).map_err(SdkError::SerializationError)
    })
    .await
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::super::test_support::write_mock_cli;
    use super::{supported_commands, supported_models, supported_models_with_env};

    #[tokio::test]
    async fn supported_models_extracts_models_from_control_response() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: read the initialize control_request, echo back a control_response
        // whose inner response.models array matches the real CLI wire format.
        let script = r#"#!/bin/sh
read -r INIT_REQ
REQ_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[],"agents":[],"output_style":"default","available_output_styles":["default"],"models":[{"value":"default","displayName":"Default (recommended)","description":"Opus 4.7 with 1M context","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsAdaptiveThinking":true,"supportsAutoMode":true},{"value":"sonnet","displayName":"Sonnet","description":"Sonnet 4.6"},{"value":"haiku","displayName":"Haiku","description":"Haiku 4.5"}],"account":{}}}}\n' "$REQ_ID"
sleep 60
"#;
        let script_path = write_mock_cli(dir.path(), script);

        let models = supported_models("/tmp", Some(script_path.as_path()))
            .await
            .expect("should return models");

        assert_eq!(models.len(), 3);
        assert_eq!(models[0].value, "default");
        assert_eq!(models[0].display_name, "Default (recommended)");
        assert_eq!(
            models[0].description.as_deref(),
            Some("Opus 4.7 with 1M context")
        );
        assert_eq!(models[0].supports_effort, Some(true));
        assert_eq!(models[0].supports_auto_mode, Some(true));
        assert_eq!(models[2].value, "haiku");
    }

    #[tokio::test]
    async fn supported_models_with_env_applies_env_to_probe_process() {
        let dir = TempDir::new().unwrap();

        let script = r#"#!/bin/sh
read -r INIT_REQ
REQ_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
DESC="${CLAUDE_CODE_USE_BEDROCK:-missing}:${ANTHROPIC_DEFAULT_SONNET_MODEL:-missing}"
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[],"models":[{"value":"sonnet","displayName":"Sonnet","description":"%s"}],"account":{}}}}\n' "$REQ_ID" "$DESC"
sleep 60
"#;
        let script_path = write_mock_cli(dir.path(), script);
        let mut env = std::collections::HashMap::new();
        env.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
        env.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
            "us.anthropic.claude-sonnet-4-6".to_string(),
        );

        let models = supported_models_with_env("/tmp", Some(script_path.as_path()), Some(env))
            .await
            .expect("should return models");

        assert_eq!(models.len(), 1);
        assert_eq!(
            models[0].description.as_deref(),
            Some("1:us.anthropic.claude-sonnet-4-6")
        );
    }

    #[tokio::test]
    async fn supported_commands_extracts_slash_commands() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: echo a control_response matching the real CLI wire
        // format (verified by manual probe against `claude` 2.1.139).
        let script = r#"#!/bin/sh
read -r INIT_REQ
REQ_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"commands":[{"name":"compact","description":"Free up context","argumentHint":""},{"name":"review","description":"Review a PR","argumentHint":""},{"name":"goal","description":"Set a goal","argumentHint":""},{"name":"nodesc","argumentHint":""}],"models":[],"account":{}}}}\n' "$REQ_ID"
sleep 60
"#;
        let script_path = write_mock_cli(dir.path(), script);

        let commands = supported_commands("/tmp", Some(script_path.as_path()))
            .await
            .unwrap();

        assert_eq!(commands.len(), 4);
        assert_eq!(commands[0].name, "compact");
        assert_eq!(commands[0].description.as_deref(), Some("Free up context"));
        assert_eq!(commands[2].name, "goal");
        assert_eq!(commands[2].description.as_deref(), Some("Set a goal"));
        assert_eq!(commands[3].name, "nodesc");
        assert!(commands[3].description.is_none());
    }
}
