//! Spawn-time push of the user-selected model / thinking effort to the
//! agent via `session/set_config_option`, before the first
//! `session/prompt`. Symmetric with `apply_initial_permission_mode`.

use crate::domain::agents::adapter::{RuntimeError, RuntimeSessionConfigValue, RuntimeSpawnConfig};

use super::apply_model_config::apply_model_config;
use super::config_options::set_config_option_thinking_effort;
use super::lifecycle::NegotiatedSession;
use super::session::AcpRuntimeSession;

/// Built-ins preserve their legacy optional/fallback behavior. Code-backed
/// installed providers require a discovered model, verify it against the live
/// ACP selector, apply it, and confirm the authoritative response before the
/// first prompt is allowed to start.
pub(super) async fn apply_initial_model(
    session: &AcpRuntimeSession,
    negotiated: &NegotiatedSession,
    config: &RuntimeSpawnConfig,
) -> Result<(), RuntimeError> {
    let required = session.hooks.requires_verified_model_selection();
    let model = match config.model.as_deref() {
        Some(model) => model,
        None if required => {
            return Err(RuntimeError::new(
                "provider requires an explicit verified model before prompting",
            ))
        }
        None => return Ok(()),
    };
    if required {
        validate_live_model(session, model).await?;
    }
    apply_model_config(
        &session.client,
        &negotiated.session_id,
        &session.current_model,
        &session.current_effort,
        &session.supports_set_config_option,
        &session.session_config,
        session.hooks.as_ref(),
        model,
    )
    .await?;
    if required {
        confirm_live_model(session, model).await?;
    }
    Ok(())
}

async fn validate_live_model(session: &AcpRuntimeSession, model: &str) -> Result<(), RuntimeError> {
    let config_id = session.hooks.model_config_id().ok_or_else(|| {
        RuntimeError::new("provider model discovery did not identify an ACP model selector")
    })?;
    let wire_value = session.hooks.model_config_value(model);
    session
        .session_config
        .snapshot()
        .await
        .validate_value(config_id, &RuntimeSessionConfigValue::Select(wire_value))
        .map_err(|error| RuntimeError::new(format!("live ACP model catalog mismatch: {error}")))
}

async fn confirm_live_model(session: &AcpRuntimeSession, model: &str) -> Result<(), RuntimeError> {
    let config_id = session.hooks.model_config_id().ok_or_else(|| {
        RuntimeError::new("provider model discovery did not identify an ACP model selector")
    })?;
    let expected = session.hooks.model_config_value(model);
    let snapshot = session.session_config.snapshot().await;
    let actual = snapshot.select_current_value(config_id).ok_or_else(|| {
        RuntimeError::new(format!(
            "live ACP response omitted model selector `{config_id}`"
        ))
    })?;
    if actual != expected {
        return Err(RuntimeError::new(format!(
            "provider did not confirm selected model `{model}`; live value is `{actual}`"
        )));
    }
    Ok(())
}

/// No-op when `config.thinking_effort` is `None`. Same fallback rules as
/// `apply_initial_model`. Skips when the catalog model id already encodes
/// effort that `apply_initial_model` will push as a companion option.
pub(super) async fn apply_initial_thinking_effort(
    session: &AcpRuntimeSession,
    negotiated: &NegotiatedSession,
    config: &RuntimeSpawnConfig,
) -> Result<(), RuntimeError> {
    let Some(effort) = config.thinking_effort.as_deref() else {
        return Ok(());
    };
    if config
        .model
        .as_deref()
        .is_some_and(|model| session.hooks.model_encodes_thinking_effort(model))
    {
        return Ok(());
    }
    let update_guard = session.session_config.lock_updates().await;
    let response = set_config_option_thinking_effort(
        &session.client,
        &negotiated.session_id,
        &session.current_effort,
        &session.supports_set_config_option,
        session.hooks.thinking_effort_config_id(),
        Some(effort),
    )
    .await?;
    session
        .session_config
        .observe_raw_response(&update_guard, response.as_ref())
        .await
}

#[cfg(test)]
mod tests {
    use super::{apply_initial_model, apply_initial_thinking_effort};
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::acp::runtime::lifecycle::NegotiatedSession;
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::runtime::session::AcpRuntimeSession;
    use crate::domain::agents::acp::runtime::session_config::snapshot_from_options;
    use crate::domain::agents::acp::{AcpClient, AcpClientInfo};
    use crate::domain::agents::adapter::{
        RuntimePermissionMode, RuntimeSessionConfigKind, RuntimeSpawnConfig,
    };
    use agent_client_protocol::schema::v1::{
        SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
    };
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
        fn model_config_id(&self) -> Option<&str> {
            Some("model")
        }
        fn thinking_effort_config_id(&self) -> Option<String> {
            Some("effort".to_string())
        }
    }

    struct StrictModelHooks;
    #[async_trait::async_trait]
    impl AcpProviderHooks for StrictModelHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }
        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
            input
        }
        fn mode_for_permission_mode(&self, _mode: RuntimePermissionMode) -> Option<String> {
            None
        }
        fn model_config_id(&self) -> Option<&str> {
            Some("model")
        }
        fn requires_verified_model_selection(&self) -> bool {
            true
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
        assemble_session_with_hooks(client, neg, Arc::new(PlainHooks))
    }

    fn assemble_session_with_hooks(
        client: &AcpClient,
        neg: &NegotiatedSession,
        hooks: Arc<dyn AcpProviderHooks>,
    ) -> AcpRuntimeSession {
        let (tx, rx) = mpsc::channel(8);
        AcpRuntimeSession::assemble(
            client,
            neg,
            std::env::temp_dir(),
            None,
            rx,
            tx,
            hooks,
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
            session_config: snapshot_from_options(&config_options("openai/gpt-5.3", "low")),
            supports_session_close: false,
            may_replay_history: false,
        }
    }

    fn config_options(model: &str, effort: &str) -> Vec<SessionConfigOption> {
        vec![
            SessionConfigOption::select(
                "model",
                "Model",
                model.to_string(),
                vec![
                    SessionConfigSelectOption::new("openai/gpt-5.3", "GPT-5.3"),
                    SessionConfigSelectOption::new("openai/gpt-5.4", "GPT-5.4"),
                ],
            )
            .category(SessionConfigOptionCategory::Model),
            SessionConfigOption::select(
                "effort",
                "Effort",
                effort.to_string(),
                vec![
                    SessionConfigSelectOption::new("low", "Low"),
                    SessionConfigSelectOption::new("high", "High"),
                ],
            )
            .category(SessionConfigOptionCategory::ThoughtLevel),
        ]
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
        assert!(req["params"].get("type").is_none());
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
    async fn strict_model_selection_rejects_missing_intent_before_any_prompt() {
        let (client, _stdout, mut stdin) = build_client().await;
        let n = neg("strict-missing");
        let s = assemble_session_with_hooks(&client, &n, Arc::new(StrictModelHooks));
        let error = apply_initial_model(&s, &n, &RuntimeSpawnConfig::default())
            .await
            .expect_err("strict providers require a model");
        assert!(error.to_string().contains("explicit verified model"));
        assert_no_frame(&mut stdin).await;
    }

    #[tokio::test]
    async fn strict_model_selection_rejects_a_stale_discovery_value() {
        let (client, _stdout, mut stdin) = build_client().await;
        let n = neg("strict-stale");
        let s = assemble_session_with_hooks(&client, &n, Arc::new(StrictModelHooks));
        let cfg = RuntimeSpawnConfig {
            model: Some("openai/removed-model".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let error = apply_initial_model(&s, &n, &cfg)
            .await
            .expect_err("live ACP choices must reject a stale discovered model");
        assert!(error
            .to_string()
            .contains("live ACP model catalog mismatch"));
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
        assert!(req["params"].get("type").is_none());
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

    #[tokio::test]
    async fn model_then_effort_preserves_the_final_authoritative_snapshot() {
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
        let session_config = s.session_config.clone();

        let task = tokio::spawn(async move {
            apply_initial_model(&s, &n, &cfg).await?;
            apply_initial_thinking_effort(&s, &n, &cfg).await
        });

        for (expected_id, options) in [
            ("model", config_options("openai/gpt-5.4", "low")),
            ("effort", config_options("openai/gpt-5.4", "high")),
        ] {
            let mut line = String::new();
            stdin.read_line(&mut line).await.unwrap();
            let req: Value = serde_json::from_str(line.trim()).unwrap();
            assert_eq!(req["method"], "session/set_config_option");
            assert!(req["params"].get("type").is_none());
            assert_eq!(req["params"]["configId"], expected_id);
            let id = req["id"].clone();
            let mut frame = serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "configOptions": options }
            }))
            .unwrap();
            frame.push(b'\n');
            stdout.write_all(&frame).await.unwrap();
        }

        task.await
            .unwrap()
            .expect("initial configuration must succeed");
        assert_eq!(
            current_model.read().await.as_deref(),
            Some("openai/gpt-5.4")
        );
        assert_eq!(current_effort.read().await.as_deref(), Some("high"));
        let snapshot = session_config.snapshot().await;
        assert!(matches!(
            &snapshot.options[1].kind,
            RuntimeSessionConfigKind::Select { current_value, .. } if current_value == "high"
        ));
    }
}
