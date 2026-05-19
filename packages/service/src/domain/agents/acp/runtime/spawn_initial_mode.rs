//! Spawn-time permission-mode application.
//!
//! Pushes the requested mode (e.g. `Plan`) to the agent right after the
//! handshake. Without this, an agent always starts in its own default mode
//! (typically `"build"`) regardless of what the user picked in the
//! new-session form. Mid-session toggles via `handle_mode_set` already use
//! the same `set_session_mode` helper; this is the matching spawn-time
//! path so the very first prompt runs in the right mode.
//!
//! Lives in its own module so `session_spawn.rs` stays under the 400-line
//! ceiling and so the spawn-time behavior is unit-testable in isolation.

use crate::domain::agents::adapter::{RuntimeError, RuntimeSpawnConfig};

use super::lifecycle::NegotiatedSession;
use super::mode_switch::set_session_mode;
use super::session::AcpRuntimeSession;

/// No-op when:
/// - `config.permission_mode` is `None` (caller didn't request a mode), or
/// - the provider doesn't map that mode to a wire id, or
/// - the agent is already in the target mode (handled by
///   `set_session_mode`'s compare-and-skip).
///
/// "Agent doesn't implement `session/set_mode`" is downgraded to a warn
/// log inside `send_set_mode` and surfaces as `Ok(())` here, so a missing
/// capability never wedges spawn.
pub(super) async fn apply_initial_permission_mode(
    session: &AcpRuntimeSession,
    negotiated: &NegotiatedSession,
    config: &RuntimeSpawnConfig,
) -> Result<(), RuntimeError> {
    let Some(mode) = config.permission_mode.clone() else {
        return Ok(());
    };
    let Some(target) = session.hooks.mode_for_permission_mode(mode) else {
        return Ok(());
    };
    set_session_mode(
        &session.client,
        &negotiated.session_id,
        &session.current_mode,
        &session.supports_set_mode,
        &target,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::apply_initial_permission_mode;
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::lifecycle::NegotiatedSession;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::runtime::session::AcpRuntimeSession;
    use crate::domain::agents::acp::{AcpClient, AcpClientInfo};
    use crate::domain::agents::adapter::{RuntimePermissionMode, RuntimeSpawnConfig};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::sync::mpsc;

    struct PlainHooks;
    #[async_trait::async_trait]
    impl AcpProviderHooks for PlainHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }
        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
            input
        }
        fn mode_for_permission_mode(&self, mode: RuntimePermissionMode) -> Option<String> {
            Some(
                if matches!(mode, RuntimePermissionMode::Plan) {
                    "plan"
                } else {
                    "build"
                }
                .to_string(),
            )
        }
        fn default_mode_id(&self) -> Option<&'static str> {
            Some("build")
        }
    }

    async fn build_client() -> (AcpClient, DuplexStream, BufReader<DuplexStream>) {
        let (cs_out, ag_out) = duplex(64 * 1024);
        let (ag_in, cs_in) = duplex(64 * 1024);
        let client = AcpClient::spawn_with_streams(
            Box::new(cs_in),
            cs_out,
            tokio::io::empty(),
            AcpClientInfo::default(),
        )
        .await
        .unwrap();
        (client, ag_out, BufReader::new(ag_in))
    }

    fn assemble_session(client: &AcpClient, neg: &NegotiatedSession) -> AcpRuntimeSession {
        let (tx, rx) = mpsc::channel(8);
        AcpRuntimeSession::assemble(
            client,
            neg,
            None,
            rx,
            tx,
            Arc::new(PlainHooks),
            Arc::new(StdMutex::new(EventIndexer::default())),
        )
    }

    fn neg(sid: &str, mode: Option<&str>) -> NegotiatedSession {
        NegotiatedSession {
            session_id: sid.to_string(),
            model: None,
            mcp_servers: Vec::new(),
            context_window: None,
            current_mode: mode.map(ToOwned::to_owned),
        }
    }

    async fn assert_no_frame(stdin: &mut BufReader<DuplexStream>) {
        let mut peek = String::new();
        let r = tokio::time::timeout(Duration::from_millis(60), stdin.read_line(&mut peek)).await;
        assert!(r.is_err(), "unexpected wire frame: {peek}");
    }

    #[tokio::test]
    async fn assemble_seeds_current_mode_from_negotiated_value() {
        let (client, _o, _i) = build_client().await;
        let s = assemble_session(&client, &neg("s", Some("plan")));
        assert_eq!(s.current_mode.read().await.as_str(), "plan");
        let (client, _o, _i) = build_client().await;
        let s = assemble_session(&client, &neg("s", None));
        assert_eq!(s.current_mode.read().await.as_str(), "build");
    }

    #[tokio::test]
    async fn skips_wire_when_unset_or_already_in_target() {
        // permission_mode=None: nothing to do.
        let (client, _o, mut stdin) = build_client().await;
        let n = neg("s", Some("build"));
        let c = RuntimeSpawnConfig::default();
        let s = assemble_session(&client, &n);
        apply_initial_permission_mode(&s, &n, &c).await.unwrap();
        assert_no_frame(&mut stdin).await;
        // Already in target mode: compare-and-skip in `set_session_mode`.
        let (client, _o, mut stdin) = build_client().await;
        let n = neg("s", Some("plan"));
        let c = RuntimeSpawnConfig {
            permission_mode: Some(RuntimePermissionMode::Plan),
            ..RuntimeSpawnConfig::default()
        };
        let s = assemble_session(&client, &n);
        apply_initial_permission_mode(&s, &n, &c).await.unwrap();
        assert_no_frame(&mut stdin).await;
    }

    #[tokio::test]
    async fn sends_set_mode_for_plan() {
        let (client, mut stdout, mut stdin) = build_client().await;
        let n = neg("s-plan", Some("build"));
        let c = RuntimeSpawnConfig {
            permission_mode: Some(RuntimePermissionMode::Plan),
            ..RuntimeSpawnConfig::default()
        };
        let s = assemble_session(&client, &n);
        let task = tokio::spawn(async move { apply_initial_permission_mode(&s, &n, &c).await });
        let mut line = String::new();
        stdin.read_line(&mut line).await.unwrap();
        let req: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(req["method"], "session/set_mode");
        assert_eq!(req["params"]["sessionId"], "s-plan");
        assert_eq!(req["params"]["modeId"], "plan");
        let id = req["id"].clone();
        let mut frame = serde_json::to_vec(&json!({ "id": id, "result": {} })).unwrap();
        frame.push(b'\n');
        stdout.write_all(&frame).await.unwrap();
        task.await.unwrap().expect("set_mode should succeed");
    }
}
