use std::collections::HashSet;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOptions,
};
use semver::Version;

use super::{
    error, policy_error, ManagedConformanceError, ManagedConformanceErrorCode,
    ManagedConformanceRequest, ModelContract,
};
use crate::domain::agents::providers::installed::managed::process_policy::{
    capture_managed_command, managed_command,
};

const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const MODEL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const MODEL_DISCOVERY_FORMAT: &str = "acp-config-options-v1";

pub(super) async fn verify_version(
    request: &ManagedConformanceRequest,
) -> Result<String, ManagedConformanceError> {
    let mut args = vec!["version".to_string()];
    args.extend(request.args.iter().cloned());
    let command = managed_command(&request.executable, &args, &request.env, &request.cwd)
        .map_err(policy_error)?;
    let output = capture_managed_command(command, VERSION_TIMEOUT)
        .await
        .map_err(|failure| version_error(format!("version command failed: {failure}")))?;
    if !output.status.success() {
        return Err(version_error(format!(
            "provider `version` command exited with {} ({} diagnostic bytes)",
            output.status,
            output.stderr.len()
        )));
    }
    validate_version_output(&output.stdout, &request.expected_provider_version)
}

fn validate_version_output(
    output: &[u8],
    expected_version: &str,
) -> Result<String, ManagedConformanceError> {
    let reported = std::str::from_utf8(output)
        .map_err(|failure| version_error(format!("version output is not UTF-8: {failure}")))?
        .trim_end_matches(['\r', '\n']);
    if reported.is_empty() || reported.lines().count() != 1 || reported.trim() != reported {
        return Err(version_error(
            "provider version must be exactly one trimmed semantic-version line",
        ));
    }
    let expected = Version::parse(expected_version).map_err(|failure| {
        version_error(format!(
            "expected package version is not semantic: {failure}"
        ))
    })?;
    let actual = Version::parse(reported)
        .map_err(|failure| version_error(format!("reported version is not semantic: {failure}")))?;
    if actual != expected || reported != expected_version {
        return Err(version_error(format!(
            "provider reported version `{reported}`, expected `{expected_version}`"
        )));
    }
    Ok(reported.to_string())
}

pub(super) async fn discover_models(
    request: &ManagedConformanceRequest,
) -> Result<ModelContract, ManagedConformanceError> {
    let mut args = vec![
        "models".to_string(),
        "--format".to_string(),
        MODEL_DISCOVERY_FORMAT.to_string(),
        "--cwd".to_string(),
        request.cwd.to_string_lossy().into_owned(),
    ];
    args.extend(request.args.iter().cloned());
    let command = managed_command(&request.executable, &args, &request.env, &request.cwd)
        .map_err(policy_error)?;
    let output = capture_managed_command(command, MODEL_DISCOVERY_TIMEOUT)
        .await
        .map_err(|failure| discovery_error(format!("model discovery failed: {failure}")))?;
    if !output.status.success() {
        return Err(discovery_error(format!(
            "provider `models` command exited with {} ({} diagnostic bytes)",
            output.status,
            output.stderr.len()
        )));
    }
    parse_model_contract(&output.stdout)
}

fn parse_model_contract(bytes: &[u8]) -> Result<ModelContract, ManagedConformanceError> {
    let options: Vec<SessionConfigOption> = serde_json::from_slice(bytes).map_err(|failure| {
        discovery_error(format!(
            "provider `models` output is not ACP v1 config-option JSON: {failure}"
        ))
    })?;
    model_contract(&options, ManagedConformanceErrorCode::ModelDiscoveryFailed)
}

pub(super) fn model_contract(
    options: &[SessionConfigOption],
    code: ManagedConformanceErrorCode,
) -> Result<ModelContract, ManagedConformanceError> {
    let mut candidates = options
        .iter()
        .filter(|option| matches!(option.category, Some(SessionConfigOptionCategory::Model)));
    let option = candidates
        .next()
        .ok_or_else(|| error(code, "model configuration is missing"))?;
    if candidates.next().is_some() {
        return Err(error(code, "multiple model configurations are ambiguous"));
    }
    let SessionConfigKind::Select(select) = &option.kind else {
        return Err(error(code, "model configuration must be a select option"));
    };
    let values = select_values(&select.options, code)?;
    let current_model = select.current_value.0.trim().to_string();
    if option.id.0.trim().is_empty() || !values.contains(&current_model) {
        return Err(error(
            code,
            "model configuration has an invalid id or default",
        ));
    }
    Ok(ModelContract {
        config_id: option.id.0.to_string(),
        current_model,
        model_ids: values,
    })
}

fn select_values(
    options: &SessionConfigSelectOptions,
    code: ManagedConformanceErrorCode,
) -> Result<Vec<String>, ManagedConformanceError> {
    let values: Vec<&str> = match options {
        SessionConfigSelectOptions::Ungrouped(options) => options
            .iter()
            .map(|option| option.value.0.as_ref())
            .collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .map(|option| option.value.0.as_ref())
            .collect(),
        _ => return Err(error(code, "model option layout is unsupported")),
    };
    let mut seen = HashSet::new();
    let mut ordered = Vec::with_capacity(values.len());
    for value in values {
        if value.trim().is_empty() || value != value.trim() || !seen.insert(value.to_string()) {
            return Err(error(code, "model ids must be non-empty and unique"));
        }
        ordered.push(value.to_string());
    }
    if ordered.is_empty() {
        return Err(error(code, "model catalog must not be empty"));
    }
    Ok(ordered)
}

fn version_error(message: impl Into<String>) -> ManagedConformanceError {
    error(ManagedConformanceErrorCode::VersionFailed, message)
}

fn discovery_error(message: impl Into<String>) -> ManagedConformanceError {
    error(ManagedConformanceErrorCode::ModelDiscoveryFailed, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_must_be_one_exact_semver_line() {
        assert_eq!(
            validate_version_output(b"1.2.3\n", "1.2.3").unwrap(),
            "1.2.3"
        );
        for value in [b"agent 1.2.3\n".as_slice(), b"1.2.3\nextra\n", b" 1.2.3\n"] {
            assert!(validate_version_output(value, "1.2.3").is_err());
        }
        assert!(validate_version_output(b"1.2.4\n", "1.2.3").is_err());
    }

    #[test]
    fn parses_grouped_model_contract() {
        let options: Vec<SessionConfigOption> = serde_json::from_value(serde_json::json!([{
            "id": "model", "name": "Model", "category": "model", "type": "select",
            "currentValue": "vendor/a", "options": [{
                "group": "Vendor", "name": "Vendor", "options": [
                    {"value": "vendor/a", "name": "A"},
                    {"value": "vendor/b", "name": "B"}
                ]
            }]
        }]))
        .unwrap();
        let contract =
            model_contract(&options, ManagedConformanceErrorCode::ModelContractMismatch).unwrap();
        assert_eq!(contract.current_model, "vendor/a");
        assert_eq!(contract.model_ids.len(), 2);
    }
}
