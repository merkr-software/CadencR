//! `session/set_mode` capability probing.
//!
//! ACP providers can omit `session/set_mode` in older builds. Treat
//! JSON-RPC `MethodNotFound` as a capability probe result, not as a user
//! visible runtime failure, mirroring `session/set_config_option`.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::SetSessionModeRequest;
use tokio::sync::RwLock;

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::RuntimeError;

use super::capability_probe::{request_optional_typed, ProbeResult};

const SET_MODE_TIMEOUT: Duration = Duration::from_secs(15);

pub async fn set_session_mode(
    client: &AcpClient,
    session_id: &str,
    current_mode: &Arc<RwLock<String>>,
    supports_flag: &Arc<AtomicBool>,
    mode_id: &str,
) -> Result<(), RuntimeError> {
    if current_mode.read().await.as_str() == mode_id {
        return Ok(());
    }
    send_set_mode(client, session_id, supports_flag, mode_id).await?;
    *current_mode.write().await = mode_id.to_string();
    Ok(())
}

async fn send_set_mode(
    client: &AcpClient,
    session_id: &str,
    supports_flag: &Arc<AtomicBool>,
    mode_id: &str,
) -> Result<(), RuntimeError> {
    let request = SetSessionModeRequest::new(session_id.to_string(), mode_id.to_string());
    match request_optional_typed(client, request, SET_MODE_TIMEOUT, supports_flag).await? {
        ProbeResult::Supported | ProbeResult::AlreadyUnsupported => Ok(()),
        ProbeResult::NewlyUnsupported => {
            tracing::warn!(
                mode_id,
                "ACP agent does not support session/set_mode; \
                 treating permission-mode switch as local state only"
            );
            Ok(())
        }
    }
}
