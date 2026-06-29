//! Spawn-time push of the user-selected model / thinking effort to the
//! agent via `session/set_config_option`, before the first
//! `session/prompt`. Symmetric with `apply_initial_permission_mode`.

use crate::domain::agents::adapter::{RuntimeError, RuntimeSpawnConfig};

use super::config_options::{set_config_option_model, set_config_option_thinking_effort};
use super::lifecycle::NegotiatedSession;
use super::session::AcpRuntimeSession;

/// No-op when `config.model` is `None`. `MethodNotFound` falls back to
/// the next prompt's legacy ride-along — see `set_config_option_model`.
pub(super) async fn apply_initial_model(
    session: &AcpRuntimeSession,
    negotiated: &NegotiatedSession,
    config: &RuntimeSpawnConfig,
) -> Result<(), RuntimeError> {
    let Some(model) = config.model.as_deref() else {
        return Ok(());
    };
    set_config_option_model(
        &session.client,
        &negotiated.session_id,
        &session.current_model,
        &session.supports_set_config_option,
        session.hooks.model_config_id(),
        model,
    )
    .await
}

/// No-op when `config.thinking_effort` is `None`. Same fallback rules as
/// `apply_initial_model`.
pub(super) async fn apply_initial_thinking_effort(
    session: &AcpRuntimeSession,
    negotiated: &NegotiatedSession,
    config: &RuntimeSpawnConfig,
) -> Result<(), RuntimeError> {
    let Some(effort) = config.thinking_effort.as_deref() else {
        return Ok(());
    };
    set_config_option_thinking_effort(
        &session.client,
        &negotiated.session_id,
        &session.current_effort,
        &session.supports_set_config_option,
        session.hooks.thinking_effort_config_id(),
        Some(effort),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{apply_initial_model, apply_initial_thinking_effort};
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
        fn mode_for_permission_mode(&self, _mode: RuntimePermissionMode) -> Option<String> {
            None
        }
        fn model_config_id(&self) -> Option<&'static str> {
            Some("model")
        }
        fn thinking_effort_config_id(&self) -> Option<&'static str> {
            Some("effort")
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
            std::env::temp_dir(),
            None,
            rx,
            tx,
            Arc::new(PlainHooks),
            Arc::new(StdMutex::new(EventIndexer::default())),
        )
    }

    fn neg(sid: &str) -> NegotiatedSession {
        NegotiatedSession {
            session_id: sid.to_string(),
            model: Some("openai/gpt-5.4".to_string()),
            mcp_servers: Vec::new(),
            context_window: None,
            current_mode: Some("build".to_string()),
        }
    }

    async fn assert_no_frame(stdin: &mut BufReader<DuplexStream>) {
        let mut peek = String::new();
        let r = tokio::time::timeout(Duration::from_millis(60), stdin.read_line(&mut peek)).await;
        assert!(r.is_err(), "unexpected wire frame: {peek}");
    }

    #[tokio::test]
    async fn apply_initial_model_sends_set_config_option_when_intent_present() {
        let (client, mut stdout, mut stdin) = build_client().await;
        let n = neg("s-1");
        let cfg = RuntimeSpawnConfig {
            model: Some("openai/gpt-5.4".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let s = assemble_session(&client, &n);
        // current_model must start as None for the short-circuit to NOT fire
        // on the very first call — that's the whole point of this path.
        assert!(
            s.current_model.read().await.is_none(),
            "current_model must not be pre-seeded from intent"
        );
        let task = tokio::spawn(async move { apply_initial_model(&s, &n, &cfg).await });
        let mut line = String::new();
        stdin.read_line(&mut line).await.unwrap();
        let req: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(req["method"], "session/set_config_option");
        assert_eq!(req["params"]["sessionId"], "s-1");
        assert_eq!(req["params"]["configId"], "model");
        assert_eq!(req["params"]["type"], "string");
        assert_eq!(req["params"]["value"], "openai/gpt-5.4");
        let id = req["id"].clone();
        let mut frame =
            serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": id, "result": {} })).unwrap();
        frame.push(b'\n');
        stdout.write_all(&frame).await.unwrap();
        task.await
            .unwrap()
            .expect("apply_initial_model should succeed");
    }

    #[tokio::test]
    async fn apply_initial_model_is_noop_when_config_model_unset() {
        let (client, _o, mut stdin) = build_client().await;
        let n = neg("s-1");
        let cfg = RuntimeSpawnConfig::default();
        let s = assemble_session(&client, &n);
        apply_initial_model(&s, &n, &cfg).await.unwrap();
        assert_no_frame(&mut stdin).await;
    }

    #[tokio::test]
    async fn apply_initial_thinking_effort_sends_set_config_option_when_intent_present() {
        let (client, mut stdout, mut stdin) = build_client().await;
        let n = neg("s-2");
        let cfg = RuntimeSpawnConfig {
            thinking_effort: Some("high".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let s = assemble_session(&client, &n);
        assert!(
            s.current_effort.read().await.is_none(),
            "current_effort must not be pre-seeded from intent"
        );
        let task = tokio::spawn(async move { apply_initial_thinking_effort(&s, &n, &cfg).await });
        let mut line = String::new();
        stdin.read_line(&mut line).await.unwrap();
        let req: Value = serde_json::from_str(line.trim()).unwrap();
        // OpenCode discriminates on `configId === "effort"` (not "thinkingEffort").
        assert_eq!(req["params"]["configId"], "effort");
        assert_eq!(req["params"]["type"], "string");
        assert_eq!(req["params"]["value"], "high");
        let id = req["id"].clone();
        let mut frame =
            serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": id, "result": {} })).unwrap();
        frame.push(b'\n');
        stdout.write_all(&frame).await.unwrap();
        task.await
            .unwrap()
            .expect("apply_initial_thinking_effort should succeed");
    }

    #[tokio::test]
    async fn apply_initial_thinking_effort_is_noop_when_config_effort_unset() {
        let (client, _o, mut stdin) = build_client().await;
        let n = neg("s-2");
        let cfg = RuntimeSpawnConfig::default();
        let s = assemble_session(&client, &n);
        apply_initial_thinking_effort(&s, &n, &cfg).await.unwrap();
        assert_no_frame(&mut stdin).await;
    }

    #[tokio::test]
    async fn method_not_found_falls_back_to_ride_along_state() {
        // If the agent says MethodNotFound, set_config_option_model still
        // writes current_model so that the legacy ride-along path can carry
        // the value on the next prompt. This test verifies the spawn-time
        // entry point inherits that property.
        let (client, mut stdout, mut stdin) = build_client().await;
        let n = neg("s-3");
        let cfg = RuntimeSpawnConfig {
            model: Some("openai/gpt-5.4".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let s = assemble_session(&client, &n);
        let supports_flag = Arc::clone(&s.supports_set_config_option);
        let current_model = Arc::clone(&s.current_model);
        let task = tokio::spawn(async move { apply_initial_model(&s, &n, &cfg).await });
        let mut line = String::new();
        stdin.read_line(&mut line).await.unwrap();
        let req: Value = serde_json::from_str(line.trim()).unwrap();
        let id = req["id"].clone();
        let mut frame = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "method not found" }
        }))
        .unwrap();
        frame.push(b'\n');
        stdout.write_all(&frame).await.unwrap();
        task.await
            .unwrap()
            .expect("MethodNotFound should not propagate as an error");
        assert!(
            !supports_flag.load(std::sync::atomic::Ordering::SeqCst),
            "MethodNotFound flips supports_set_config_option to false"
        );
        assert_eq!(
            current_model.read().await.as_deref(),
            Some("openai/gpt-5.4"),
            "current_model is still updated so the ride-along path picks it up"
        );
    }

    /// Mirrors what `spawn_acp_runtime_session` does: race both apply_initial_*
    /// calls under `try_join!`. They share the atomic supports flag but write
    /// to disjoint locks; both wire frames must land and both local states
    /// must reflect the user's intent. Catches a regression where naive
    /// shared-lock contention or task ordering breaks the parallel path.
    #[tokio::test]
    async fn try_join_pushes_both_model_and_effort_concurrently() {
        let (client, mut stdout, mut stdin) = build_client().await;
        let n = neg("s-join");
        let cfg = RuntimeSpawnConfig {
            model: Some("openai/gpt-5.4".to_string()),
            thinking_effort: Some("high".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let s = assemble_session(&client, &n);
        let current_model = Arc::clone(&s.current_model);
        let current_effort = Arc::clone(&s.current_effort);

        let task = tokio::spawn(async move {
            tokio::try_join!(
                apply_initial_model(&s, &n, &cfg),
                apply_initial_thinking_effort(&s, &n, &cfg),
            )
        });

        // Drain BOTH frames in whatever order they arrive, ack each one.
        // We don't assert order — only that both configIds show up exactly
        // once. This is the contract `try_join!` provides.
        let mut seen = std::collections::HashSet::new();
        for _ in 0..2 {
            let mut line = String::new();
            stdin.read_line(&mut line).await.unwrap();
            let req: Value = serde_json::from_str(line.trim()).unwrap();
            assert_eq!(req["method"], "session/set_config_option");
            assert_eq!(req["params"]["type"], "string");
            let cid = req["params"]["configId"].as_str().unwrap().to_owned();
            assert!(seen.insert(cid.clone()), "duplicate configId on the wire");
            let id = req["id"].clone();
            let mut frame =
                serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": id, "result": {} })).unwrap();
            frame.push(b'\n');
            stdout.write_all(&frame).await.unwrap();
        }
        assert_eq!(
            seen,
            std::collections::HashSet::from(["model".to_owned(), "effort".to_owned()]),
            "both configIds must reach the agent under try_join!"
        );

        task.await.unwrap().expect("try_join must succeed");
        assert_eq!(
            current_model.read().await.as_deref(),
            Some("openai/gpt-5.4")
        );
        assert_eq!(current_effort.read().await.as_deref(), Some("high"));
    }
}
