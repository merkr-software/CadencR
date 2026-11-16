use std::path::Path;

use agent_client_protocol::schema::v1::{LoadSessionRequest, ResumeSessionRequest};

use super::{
    cleanup_session, error, initialize, initialize_error, reconcile_models, spawn_client,
    LifecycleCapabilities, ManagedConformanceError, ManagedConformanceErrorCode,
    ManagedConformanceRequest, ManagedProbeOutcome, ModelContract, SESSION_TIMEOUT,
};
use crate::domain::agents::acp::{AcpClient, AcpError};

type RestoreOutcomes = (
    ManagedProbeOutcome,
    ManagedProbeOutcome,
    ManagedProbeOutcome,
);

pub(super) async fn probe_fresh_restore(
    request: &ManagedConformanceRequest,
    session_id: &str,
    expected_capabilities: LifecycleCapabilities,
    discovered: &ModelContract,
) -> Result<RestoreOutcomes, ManagedConformanceError> {
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

async fn restore_and_cleanup(
    client: &AcpClient,
    session_id: &str,
    cwd: &Path,
    capabilities: LifecycleCapabilities,
    expected: &ModelContract,
) -> Result<RestoreOutcomes, ManagedConformanceError> {
    let (response, outcomes, method) = if capabilities.resume {
        let response = client
            .send_request_typed(
                ResumeSessionRequest::new(session_id.to_string(), cwd.to_path_buf()),
                SESSION_TIMEOUT,
            )
            .await
            .map(|response| response.config_options);
        (
            response,
            (ManagedProbeOutcome::Passed, unprobed(capabilities.load)),
            "session/resume",
        )
    } else {
        let response = client
            .send_request_typed(
                LoadSessionRequest::new(session_id.to_string(), cwd.to_path_buf()),
                SESSION_TIMEOUT,
            )
            .await
            .map(|response| response.config_options);
        (
            response,
            (
                ManagedProbeOutcome::NotAdvertised,
                ManagedProbeOutcome::Passed,
            ),
            "session/load",
        )
    };
    let options = match response {
        Ok(options) => options,
        Err(failure) if empty_session_not_retained(&failure, session_id) => {
            // Some agents persist only after the first user turn. This probe
            // sends no prompt, so an explicit absence of its exact disposable
            // session cannot prove durable restore. Record that limit rather
            // than claiming success or creating replacement context.
            return Ok((
                unprobed(capabilities.resume),
                unprobed(capabilities.load),
                unprobed(capabilities.close),
            ));
        }
        Err(failure) => {
            return Err(error(
                ManagedConformanceErrorCode::RestoreFailed,
                format!("ACP {method} failed: {failure}"),
            ));
        }
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

fn unprobed(advertised: bool) -> ManagedProbeOutcome {
    if advertised {
        ManagedProbeOutcome::Unprobed
    } else {
        ManagedProbeOutcome::NotAdvertised
    }
}

fn empty_session_not_retained(failure: &AcpError, session_id: &str) -> bool {
    let AcpError::Rpc {
        code: -32602,
        data: Some(data),
        ..
    } = failure
    else {
        return false;
    };
    data.get("message").and_then(serde_json::Value::as_str)
        == Some(format!("Session \"{session_id}\" not found").as_str())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn only_an_explicit_rpc_absence_of_this_exact_disposable_session_is_unprobed() {
        let missing = |code, data| AcpError::Rpc {
            code,
            message: "Invalid params".into(),
            data,
        };
        let detail = json!({"message": "Session \"probe-id\" not found"});
        assert!(empty_session_not_retained(
            &missing(-32602, Some(detail.clone())),
            "probe-id"
        ));
        for failure in [
            missing(-32601, Some(detail.clone())),
            missing(-32000, Some(detail)),
            missing(-32602, None),
            missing(
                -32602,
                Some(json!({"message": "Session \"another-id\" not found"})),
            ),
            missing(-32602, Some(json!({"message": "Model not found"}))),
            missing(-32602, Some(json!("Session \"probe-id\" not found"))),
            AcpError::Timeout("session/load"),
            AcpError::Protocol("Session \"probe-id\" not found".into()),
        ] {
            assert!(!empty_session_not_retained(&failure, "probe-id"));
        }
    }
}
