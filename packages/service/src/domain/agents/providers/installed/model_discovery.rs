//! Pre-session model discovery for code-backed provider executables.
//!
//! ACP owns the live session configuration contract, but v1 only exposes that
//! state after `session/new`. Cadencr requires a model choice before a session
//! may start, so an installed provider binary must also implement the bounded
//! `models` command defined in `docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md`.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    SessionConfigSelectOptions,
};
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::domain::agents::runtime::ModelCatalogEntry;

use super::installation::LocalExecutable;
#[cfg(test)]
use super::managed::process_policy::managed_command;
use super::managed::process_policy::{capture_managed_command, ManagedCommandOutput};
use super::provider_command::{prepare_provider_command, PreparedProviderCommand};

pub const MODEL_DISCOVERY_FORMAT: &str = "acp-config-options-v1";
const MODEL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DISCOVERY_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct DiscoveredModels {
    pub config_id: String,
    pub default_model: String,
    pub models: Vec<ModelCatalogEntry>,
}

#[derive(Debug, Clone)]
pub struct ModelDiscoveryError(String);

impl ModelDiscoveryError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for ModelDiscoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ModelDiscoveryError {}

/// Execute the provider-owned parser. The runtime command and descriptor args
/// are reused, then the discovery subcommand is appended. No shell participates.
pub async fn discover_models(
    executable: &LocalExecutable,
    cwd: &Path,
) -> Result<DiscoveredModels, ModelDiscoveryError> {
    let args = [
        OsString::from("models"),
        OsString::from("--format"),
        OsString::from(MODEL_DISCOVERY_FORMAT),
        OsString::from("--cwd"),
        cwd.as_os_str().to_owned(),
    ];
    let PreparedProviderCommand {
        mut command,
        process_tree_policy,
    } = prepare_provider_command(executable, &args, cwd, None)
        .await
        .map_err(|error| {
            ModelDiscoveryError::new(format!(
                "could not prepare provider model discovery: {error}"
            ))
        })?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let is_managed = matches!(
        process_tree_policy,
        crate::domain::agents::acp::AcpProcessTreePolicy::Isolated(_)
    );
    let output = capture_model_command(command, is_managed, MODEL_DISCOVERY_TIMEOUT).await?;
    if !output.status.success() {
        // Provider stderr can contain credentials. Record only its bounded byte
        // count; provider authors can reproduce the command in a terminal.
        return Err(ModelDiscoveryError::new(format!(
            "provider `models` command exited with {} ({} diagnostic bytes)",
            output.status,
            output.stderr.len()
        )));
    }
    parse_models(&output.stdout)
}

async fn capture_model_command(
    command: tokio::process::Command,
    is_managed: bool,
    timeout: Duration,
) -> Result<ManagedCommandOutput, ModelDiscoveryError> {
    if is_managed {
        return capture_managed_command(command, timeout)
            .await
            .map_err(|error| {
                ModelDiscoveryError::new(format!(
                    "managed provider model discovery failed: {error}"
                ))
            });
    }
    capture_local_model_command(command, timeout).await
}

async fn capture_local_model_command(
    mut command: tokio::process::Command,
    timeout: Duration,
) -> Result<ManagedCommandOutput, ModelDiscoveryError> {
    let mut child = command.spawn().map_err(|error| {
        ModelDiscoveryError::new(format!("could not start provider model discovery: {error}"))
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        ModelDiscoveryError::new("provider model discovery stdout was unavailable")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ModelDiscoveryError::new("provider model discovery stderr was unavailable")
    })?;
    let mut stdout_task = tokio::spawn(read_bounded(stdout));
    let mut stderr_task = tokio::spawn(read_bounded(stderr));

    let capture = async {
        let wait = async {
            child.wait().await.map_err(|error| {
                ModelDiscoveryError::new(format!(
                    "provider model discovery failed to wait: {error}"
                ))
            })
        };
        let stdout = async {
            (&mut stdout_task).await.map_err(|error| {
                ModelDiscoveryError::new(format!("stdout reader failed: {error}"))
            })?
        };
        let stderr = async {
            (&mut stderr_task).await.map_err(|error| {
                ModelDiscoveryError::new(format!("stderr reader failed: {error}"))
            })?
        };
        tokio::try_join!(wait, stdout, stderr)
    };
    match tokio::time::timeout(timeout, capture).await {
        Ok(Ok((status, stdout, stderr))) => Ok(ManagedCommandOutput {
            status,
            stdout,
            stderr,
        }),
        Ok(Err(error)) => {
            let _ = child.kill().await;
            stdout_task.abort();
            stderr_task.abort();
            Err(error)
        }
        Err(_) => {
            let _ = child.kill().await;
            stdout_task.abort();
            stderr_task.abort();
            Err(ModelDiscoveryError::new(format!(
                "provider model discovery timed out after {} seconds",
                timeout.as_secs()
            )))
        }
    }
}

async fn read_bounded(mut reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, ModelDiscoveryError> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await.map_err(|error| {
            ModelDiscoveryError::new(format!("could not read provider output: {error}"))
        })?;
        if count == 0 {
            break;
        }
        if bytes.len().saturating_add(count) > MAX_DISCOVERY_OUTPUT_BYTES {
            return Err(ModelDiscoveryError::new(format!(
                "provider output exceeded {MAX_DISCOVERY_OUTPUT_BYTES} bytes"
            )));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(bytes)
}

fn parse_models(bytes: &[u8]) -> Result<DiscoveredModels, ModelDiscoveryError> {
    let options: Vec<SessionConfigOption> = serde_json::from_slice(bytes).map_err(|error| {
        ModelDiscoveryError::new(format!(
            "provider `models` output is not ACP v1 config-option JSON: {error}"
        ))
    })?;
    let primary = options
        .iter()
        .find(|option| matches!(option.category, Some(SessionConfigOptionCategory::Model)))
        .ok_or_else(|| {
            ModelDiscoveryError::new("provider `models` output has no `model` category")
        })?;
    let config_id = primary.id.0.trim();
    if config_id.is_empty() || config_id != primary.id.0.as_ref() {
        return Err(ModelDiscoveryError::new(
            "provider model configuration ID must be non-empty and trimmed",
        ));
    }
    let SessionConfigKind::Select(select) = &primary.kind else {
        return Err(ModelDiscoveryError::new(
            "provider primary model configuration must be a select option",
        ));
    };
    let choices = flatten_options(&select.options)?;
    if choices.is_empty() {
        return Err(ModelDiscoveryError::new(
            "provider `models` command returned an empty model list",
        ));
    }

    let default_model = select.current_value.0.trim().to_string();
    let mut ids = HashSet::new();
    let mut models = Vec::with_capacity(choices.len());
    for choice in choices {
        let id = choice.value.0.trim();
        if id.is_empty() || id != choice.value.0.as_ref() {
            return Err(ModelDiscoveryError::new(
                "provider model IDs must be non-empty and have no surrounding whitespace",
            ));
        }
        if !ids.insert(id.to_string()) {
            return Err(ModelDiscoveryError::new(format!(
                "provider `models` command returned duplicate model ID `{id}`"
            )));
        }
        let metadata = model_metadata(choice)?;
        models.push(ModelCatalogEntry {
            id: id.to_string(),
            label: choice.name.clone(),
            description: choice.description.clone(),
            supports_effort: metadata.supports_effort,
            supported_effort_levels: metadata.supported_effort_levels,
            default_effort_level: metadata.default_effort_level,
            supports_adaptive_thinking: metadata.supports_adaptive_thinking,
            supports_fast_mode: metadata.supports_fast_mode,
            supports_auto_mode: metadata.supports_auto_mode,
        });
    }
    if default_model.is_empty() || !ids.contains(&default_model) {
        return Err(ModelDiscoveryError::new(format!(
            "provider default model `{default_model}` is not in its model list"
        )));
    }
    Ok(DiscoveredModels {
        config_id: config_id.to_string(),
        default_model,
        models,
    })
}

fn flatten_options(
    options: &SessionConfigSelectOptions,
) -> Result<Vec<&SessionConfigSelectOption>, ModelDiscoveryError> {
    match options {
        SessionConfigSelectOptions::Ungrouped(options) => Ok(options.iter().collect()),
        SessionConfigSelectOptions::Grouped(groups) => Ok(groups
            .iter()
            .flat_map(|group| group.options.iter())
            .collect()),
        _ => Err(ModelDiscoveryError::new(
            "provider model selector uses an unsupported ACP option layout",
        )),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CadencrModelMetadata {
    supports_effort: Option<bool>,
    supported_effort_levels: Option<Vec<String>>,
    default_effort_level: Option<String>,
    supports_adaptive_thinking: Option<bool>,
    supports_fast_mode: Option<bool>,
    supports_auto_mode: Option<bool>,
}

fn model_metadata(
    option: &SessionConfigSelectOption,
) -> Result<CadencrModelMetadata, ModelDiscoveryError> {
    let Some(value) = option.meta.as_ref().and_then(|meta| meta.get("cadencr")) else {
        return Ok(CadencrModelMetadata::default());
    };
    serde_json::from_value(value.clone()).map_err(|error| {
        ModelDiscoveryError::new(format!(
            "model `{}` has invalid `_meta.cadencr`: {error}",
            option.value.0
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        capture_model_command, managed_command, parse_models, read_bounded,
        MAX_DISCOVERY_OUTPUT_BYTES,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    #[cfg(unix)]
    #[test]
    fn managed_discovery_descendant_helper() {
        let Some(pid_file) = std::env::var_os("MODEL_DISCOVERY_TEST_PID_FILE") else {
            return;
        };
        let mut descendant = std::process::Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .expect("spawn descendant");
        std::fs::write(pid_file, descendant.id().to_string()).expect("write descendant pid");
        let _ = descendant.wait();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn managed_discovery_timeout_terminates_descendants() {
        let directory = tempfile::tempdir().expect("test directory");
        let pid_file = directory.path().join("descendant.pid");
        let executable = std::env::current_exe().expect("current test executable");
        let test_module = module_path!()
            .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::"))
            .unwrap_or(module_path!());
        let helper_name = format!("{test_module}::managed_discovery_descendant_helper");
        let environment = BTreeMap::from([(
            "MODEL_DISCOVERY_TEST_PID_FILE".into(),
            pid_file.to_string_lossy().into_owned(),
        )]);
        let command = managed_command(
            &executable,
            &["--exact".into(), helper_name, "--nocapture".into()],
            &environment,
            directory.path(),
        )
        .expect("prepare managed discovery helper");

        let error = capture_model_command(command, true, std::time::Duration::from_secs(1))
            .await
            .expect_err("managed discovery helper must time out");
        assert!(error.to_string().contains("timed out"), "{error}");
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .expect("helper should publish descendant pid")
            .parse()
            .expect("numeric descendant pid");
        for _ in 0..50 {
            if unsafe { libc::kill(pid, 0) } != 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("managed model-discovery descendant {pid} survived timeout");
    }

    #[test]
    fn parses_rich_acp_model_options() {
        let value = json!([{
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": "vendor/opus",
            "options": [{
                "value": "vendor/opus",
                "name": "Opus",
                "description": "Deep coding",
                "_meta": { "cadencr": {
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "high"],
                    "defaultEffortLevel": "high"
                }}
            }]
        }]);
        let parsed = parse_models(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(parsed.config_id, "model");
        assert_eq!(parsed.default_model, "vendor/opus");
        assert_eq!(parsed.models[0].label, "Opus");
        assert_eq!(parsed.models[0].supports_effort, Some(true));
        assert_eq!(
            parsed.models[0].supported_effort_levels.as_deref(),
            Some(["low".to_string(), "high".to_string()].as_slice())
        );
    }

    #[test]
    fn rejects_empty_duplicate_and_unknown_defaults() {
        let cases = [
            json!([{
                "id": "model", "name": "Model", "category": "model", "type": "select",
                "currentValue": "missing", "options": []
            }]),
            json!([{
                "id": "model", "name": "Model", "category": "model", "type": "select",
                "currentValue": "a", "options": [
                    { "value": "a", "name": "A" }, { "value": "a", "name": "Again" }
                ]
            }]),
            json!([{
                "id": "model", "name": "Model", "category": "model", "type": "select",
                "currentValue": "missing", "options": [{ "value": "a", "name": "A" }]
            }]),
        ];
        for value in cases {
            assert!(parse_models(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }

    #[tokio::test]
    async fn bounded_reader_rejects_output_immediately_after_the_limit() {
        let bytes = vec![b'x'; MAX_DISCOVERY_OUTPUT_BYTES + 1];
        let error = read_bounded(std::io::Cursor::new(bytes)).await.unwrap_err();
        assert!(error.to_string().contains("exceeded"));
    }
}
