use std::path::Path;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, CloseSessionRequest, Implementation, InitializeRequest,
    LoadSessionRequest, NewSessionRequest, ResumeSessionRequest, SessionConfigOption,
    SetSessionConfigOptionRequest,
};
use agent_client_protocol::schema::ProtocolVersion;

use super::command_probe::model_contract;
use super::{
    error, policy_error, ManagedConformanceError, ManagedConformanceErrorCode,
    ManagedConformanceReport, ManagedConformanceRequest, ManagedProbeOutcome, ModelContract,
};
use crate::domain::agents::acp::{AcpClient, AcpClientInfo, AcpSpawnOptions, AcpStderrPolicy};
use crate::domain::agents::providers::installed::managed::process_policy::{
    managed_command, managed_process_tree_policy, MANAGED_MAX_STDERR_LINE_BYTES,
};

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);
const SESSION_TIMEOUT: Duration = Duration::from_secs(20);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LifecycleCapabilities {
    resume: bool,
    load: bool,
    close: bool,
}

struct InitialProbe {
    session_id: String,
    capabilities: LifecycleCapabilities,
}

pub(super) async fn probe_acp(
    request: ManagedConformanceRequest,
    discovered: ModelContract,
    verified_version: String,
) -> Result<ManagedConformanceReport, ManagedConformanceError> {
    let original = spawn_client(&request).await?;
    let initial = probe_initial_session(&original, &request, &discovered).await;
    let initial = match initial {
        Ok(initial) => initial,
        Err(failure) => {
            original.shutdown().await;
            return Err(failure);
        }
    };
    let (resume, load, close) = if initial.capabilities.resume || initial.capabilities.load {
        // Durable restore is a process boundary. Do not send terminal
        // `session/close` before the fresh process has resumed the opaque id.
        original.shutdown().await;
        probe_fresh_restore(
            &request,
            &initial.session_id,
            initial.capabilities,
            &discovered,
        )
        .await?
    } else {
        let close =
            cleanup_session(&original, &initial.session_id, initial.capabilities.close).await;
        original.shutdown().await;
        (
            ManagedProbeOutcome::NotAdvertised,
            ManagedProbeOutcome::NotAdvertised,
            close?,
        )
    };
    Ok(ManagedConformanceReport {
        version: ManagedProbeOutcome::Passed,
        verified_version,
        session_id: initial.session_id,
        model_config_id: discovered.config_id,
        model_ids: discovered.model_ids.clone(),
        default_model: discovered.current_model,
        discovered_model_count: discovered.model_ids.len(),
        resume,
        load,
        close,
        prompt: ManagedProbeOutcome::Unprobed,
        os_sandbox_applied: false,
    })
}

async fn spawn_client(
    request: &ManagedConformanceRequest,
) -> Result<AcpClient, ManagedConformanceError> {
    let mut runtime_args = vec![
        "run".to_string(),
        "--protocol".to_string(),
        "acp-v1".to_string(),
    ];
    runtime_args.extend(request.args.iter().cloned());
    let command = managed_command(
        &request.executable,
        &runtime_args,
        &request.env,
        &request.cwd,
    )
    .map_err(policy_error)?;
    AcpClient::spawn(
        AcpSpawnOptions::builder()
            .command(command)
            .client_info(AcpClientInfo::default())
            .max_line_bytes(MANAGED_MAX_STDERR_LINE_BYTES)
            .stderr_policy(AcpStderrPolicy::Discard)
            .process_tree_policy(managed_process_tree_policy())
            .build(),
    )
    .await
    .map_err(|failure| initialize_error(format!("could not spawn ACP process: {failure}")))
}

async fn probe_initial_session(
    client: &AcpClient,
    request: &ManagedConformanceRequest,
    discovered: &ModelContract,
) -> Result<InitialProbe, ManagedConformanceError> {
    let capabilities = initialize(client, &request.expected_provider_version).await?;
    let session = client
        .send_request_typed(NewSessionRequest::new(request.cwd.clone()), SESSION_TIMEOUT)
        .await
        .map_err(|failure| session_error(format!("ACP session/new failed: {failure}")))?;
    let session_id = session.session_id.to_string();
    let verification =
        verify_and_set_model(client, &session_id, session.config_options, discovered).await;
    if let Err(failure) = verification {
        let _ = cleanup_session(client, &session_id, capabilities.close).await;
        return Err(failure);
    }
    Ok(InitialProbe {
        session_id,
        capabilities,
    })
}

async fn probe_fresh_restore(
    request: &ManagedConformanceRequest,
    session_id: &str,
    expected_capabilities: LifecycleCapabilities,
    discovered: &ModelContract,
) -> Result<
    (
        ManagedProbeOutcome,
        ManagedProbeOutcome,
        ManagedProbeOutcome,
    ),
    ManagedConformanceError,
> {
    let client = spawn_client(request).await?;
    let result = async {
        let capabilities = initialize(&client, &request.expected_provider_version).await?;
        if capabilities != expected_capabilities {
            return Err(initialize_error(
                "ACP lifecycle capabilities changed between fresh processes",
            ));
        }
        restore_and_cleanup(&client, session_id, &request.cwd, capabilities, discovered).await
    }
    .await;
    client.shutdown().await;
    result
}

async fn initialize(
    client: &AcpClient,
    expected_version: &str,
) -> Result<LifecycleCapabilities, ManagedConformanceError> {
    let response = client
        .send_request_typed(initialize_request(), INITIALIZE_TIMEOUT)
        .await
        .map_err(|failure| initialize_error(format!("ACP initialize failed: {failure}")))?;
    if response.protocol_version != ProtocolVersion::V1 {
        return Err(initialize_error("agent did not negotiate ACP v1"));
    }
    if let Some(agent_info) = response.agent_info.as_ref() {
        if agent_info.version != expected_version {
            return Err(error(
                ManagedConformanceErrorCode::VersionFailed,
                format!(
                    "ACP agentInfo.version `{}` differs from verified package version `{expected_version}`",
                    agent_info.version
                ),
            ));
        }
    }
    Ok(LifecycleCapabilities {
        resume: response
            .agent_capabilities
            .session_capabilities
            .resume
            .is_some(),
        load: response.agent_capabilities.load_session,
        close: response
            .agent_capabilities
            .session_capabilities
            .close
            .is_some(),
    })
}

fn initialize_request() -> InitializeRequest {
    InitializeRequest::new(ProtocolVersion::V1)
        .client_capabilities(ClientCapabilities::new())
        .client_info(Implementation::new(
            "cadencr-conformance",
            env!("CARGO_PKG_VERSION"),
        ))
}

async fn verify_and_set_model(
    client: &AcpClient,
    session_id: &str,
    options: Option<Vec<SessionConfigOption>>,
    expected: &ModelContract,
) -> Result<(), ManagedConformanceError> {
    reconcile_models(
        options.as_deref(),
        expected,
        ManagedConformanceErrorCode::ModelContractMismatch,
        "ACP session/new model selector differs from pre-session discovery",
    )?;
    let response = client
        .send_request_typed(
            SetSessionConfigOptionRequest::new(
                session_id.to_string(),
                expected.config_id.clone(),
                expected.current_model.as_str(),
            ),
            SESSION_TIMEOUT,
        )
        .await
        .map_err(|failure| configuration_error(format!("model selection failed: {failure}")))?;
    reconcile_models(
        Some(&response.config_options),
        expected,
        ManagedConformanceErrorCode::ConfigurationFailed,
        "agent did not confirm the selected default model",
    )
}

async fn restore_and_cleanup(
    client: &AcpClient,
    session_id: &str,
    cwd: &Path,
    capabilities: LifecycleCapabilities,
    expected: &ModelContract,
) -> Result<
    (
        ManagedProbeOutcome,
        ManagedProbeOutcome,
        ManagedProbeOutcome,
    ),
    ManagedConformanceError,
> {
    let (options, outcomes) = if capabilities.resume {
        let response = client
            .send_request_typed(
                ResumeSessionRequest::new(session_id.to_string(), cwd.to_path_buf()),
                SESSION_TIMEOUT,
            )
            .await
            .map_err(|failure| restore_error(format!("ACP session/resume failed: {failure}")))?;
        let load = if capabilities.load {
            ManagedProbeOutcome::Unprobed
        } else {
            ManagedProbeOutcome::NotAdvertised
        };
        (response.config_options, (ManagedProbeOutcome::Passed, load))
    } else {
        let response = client
            .send_request_typed(
                LoadSessionRequest::new(session_id.to_string(), cwd.to_path_buf()),
                SESSION_TIMEOUT,
            )
            .await
            .map_err(|failure| restore_error(format!("ACP session/load failed: {failure}")))?;
        (
            response.config_options,
            (
                ManagedProbeOutcome::NotAdvertised,
                ManagedProbeOutcome::Passed,
            ),
        )
    };
    let reconciliation = reconcile_models(
        options.as_deref(),
        expected,
        ManagedConformanceErrorCode::RestoreFailed,
        "restored ACP session did not preserve the reconciled model configuration",
    );
    let cleanup = cleanup_session(client, session_id, capabilities.close).await;
    reconciliation?;
    let close = cleanup?;
    Ok((outcomes.0, outcomes.1, close))
}

fn reconcile_models(
    options: Option<&[SessionConfigOption]>,
    expected: &ModelContract,
    code: ManagedConformanceErrorCode,
    message: &str,
) -> Result<(), ManagedConformanceError> {
    let actual = model_contract(options.unwrap_or_default(), code)?;
    if actual.config_id != expected.config_id
        || actual.model_ids != expected.model_ids
        || actual.current_model != expected.current_model
    {
        return Err(error(code, message));
    }
    Ok(())
}

async fn cleanup_session(
    client: &AcpClient,
    session_id: &str,
    supports_close: bool,
) -> Result<ManagedProbeOutcome, ManagedConformanceError> {
    if supports_close {
        let close = client
            .send_request_typed(
                CloseSessionRequest::new(session_id.to_string()),
                CLEANUP_TIMEOUT,
            )
            .await;
        if close.is_ok() {
            return Ok(ManagedProbeOutcome::Passed);
        }
        let cancel = client
            .send_notification_typed(CancelNotification::new(session_id.to_string()))
            .await;
        let suffix = cancel
            .err()
            .map(|failure| format!("; cancel fallback also failed: {failure}"))
            .unwrap_or_default();
        return Err(error(
            ManagedConformanceErrorCode::CleanupFailed,
            format!(
                "advertised ACP session/close failed: {}{suffix}",
                close.expect_err("close result was checked")
            ),
        ));
    }
    client
        .send_notification_typed(CancelNotification::new(session_id.to_string()))
        .await
        .map(|()| ManagedProbeOutcome::NotAdvertised)
        .map_err(|failure| {
            error(
                ManagedConformanceErrorCode::CleanupFailed,
                format!("managed conformance session cleanup failed: {failure}"),
            )
        })
}

fn initialize_error(message: impl Into<String>) -> ManagedConformanceError {
    error(ManagedConformanceErrorCode::InitializeFailed, message)
}

fn session_error(message: impl Into<String>) -> ManagedConformanceError {
    error(ManagedConformanceErrorCode::SessionNewFailed, message)
}

fn configuration_error(message: impl Into<String>) -> ManagedConformanceError {
    error(ManagedConformanceErrorCode::ConfigurationFailed, message)
}

fn restore_error(message: impl Into<String>) -> ManagedConformanceError {
    error(ManagedConformanceErrorCode::RestoreFailed, message)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::super::{
        verify_managed_provider, ManagedConformanceErrorCode, ManagedConformanceRequest,
        ManagedProbeOutcome,
    };

    #[cfg(unix)]
    fn wrapped_fixture(directory: &std::path::Path) -> (PathBuf, BTreeMap<String, String>) {
        use std::os::unix::fs::PermissionsExt as _;

        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_acp_agent.py");
        let wrapper = directory.join("managed-fixture");
        std::fs::write(
            &wrapper,
            b"#!/bin/sh\nif [ \"$1\" = version ]; then printf '1.0.0\\n'; exit 0; fi\nexec \"$FAKE_AGENT\" \"$@\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let environment = BTreeMap::from([(
            "FAKE_AGENT".to_string(),
            fixture.to_string_lossy().into_owned(),
        )]);
        (wrapper, environment)
    }

    #[cfg(unix)]
    fn request(
        cwd: &std::path::Path,
        executable: PathBuf,
        env: BTreeMap<String, String>,
        args: Vec<String>,
        expected_version: &str,
    ) -> ManagedConformanceRequest {
        ManagedConformanceRequest::builder()
            .executable(executable)
            .args(args)
            .env(env)
            .cwd(cwd.to_path_buf())
            .expected_provider_version(expected_version.to_string())
            .build()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_agent_passes_without_a_prompt() {
        let cwd = tempfile::tempdir().unwrap();
        let (executable, env) = wrapped_fixture(cwd.path());
        let report =
            verify_managed_provider(request(cwd.path(), executable, env, Vec::new(), "1.0.0"))
                .await
                .unwrap();
        assert_eq!(report.version, ManagedProbeOutcome::Passed);
        assert_eq!(report.verified_version, "1.0.0");
        assert_eq!(report.model_config_id, "model");
        assert_eq!(report.model_ids, ["fake-small", "fake-large"]);
        assert_eq!(report.default_model, "fake-small");
        assert_eq!(report.resume, ManagedProbeOutcome::NotAdvertised);
        assert_eq!(report.load, ManagedProbeOutcome::NotAdvertised);
        assert_eq!(report.close, ManagedProbeOutcome::Passed);
        assert_eq!(report.prompt, ManagedProbeOutcome::Unprobed);
        assert!(!report.os_sandbox_applied);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resume_uses_a_fresh_process_after_closing_the_active_session() {
        let cwd = tempfile::tempdir().unwrap();
        let executable = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/managed_reject_active_resume_agent.py");
        let state = cwd.path().join("state.json");
        let forbidden = cwd.path().join("forbidden-method");
        let args = vec![
            "--state".into(),
            state.to_string_lossy().into_owned(),
            "--forbidden".into(),
            forbidden.to_string_lossy().into_owned(),
        ];

        let report = verify_managed_provider(request(
            cwd.path(),
            executable,
            BTreeMap::new(),
            args,
            "1.2.3",
        ))
        .await
        .unwrap();
        assert_eq!(report.resume, ManagedProbeOutcome::Passed);
        assert_eq!(report.load, ManagedProbeOutcome::Unprobed);
        assert_eq!(report.close, ManagedProbeOutcome::Passed);
        assert!(!forbidden.exists(), "conformance sent a prompt/auth method");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exact_version_mismatch_fails_before_model_discovery() {
        let cwd = tempfile::tempdir().unwrap();
        let (executable, env) = wrapped_fixture(cwd.path());
        let mut request = request(cwd.path(), executable, env, Vec::new(), "1.0.0");
        request.expected_provider_version = "1.2.4".into();

        let failure = verify_managed_provider(request).await.unwrap_err();
        assert_eq!(failure.code, ManagedConformanceErrorCode::VersionFailed);
    }
}
