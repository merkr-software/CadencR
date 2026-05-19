use axum::extract::ws::Message;
use tracing::{debug, warn};

use super::helpers::{
    parse_permission_mode, post_plan_approval_fallback_mode_wire, post_plan_approval_mode_wire,
};
use super::types::{QueryState, SdkHandle, SdkSessions, WsSender};
use crate::domain::agents::adapter::{
    RuntimeError, RuntimePermissionDecision, RuntimePermissionMode, RuntimePermissionResponseKind,
    RuntimeSessionHandle,
};
use crate::domain::agents::permission_modes::permission_mode_wire;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::WsEnvelope;

pub(crate) fn should_transition_after_plan_approval(
    kind: RuntimePermissionResponseKind,
    decision: RuntimePermissionDecision,
) -> bool {
    kind == RuntimePermissionResponseKind::PlanApproval
        && matches!(
            decision,
            RuntimePermissionDecision::AllowOnce | RuntimePermissionDecision::AllowFuture
        )
}

pub(super) async fn transition_session_to_post_plan_mode(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    write_pool: &sqlx::SqlitePool,
    sender: &WsSender,
) -> Result<Option<String>, RuntimeError> {
    let (transition, runtime_provider) = {
        let mut sessions = sdk_sessions.lock().await;
        let Some(handle) = sessions.get_mut(&db_session_id) else {
            warn!(
                db_session_id,
                "post-plan-approval: session handle missing, skipping mode transition"
            );
            return Ok(None);
        };
        (
            plan_post_plan_mode_transition(handle),
            handle.runtime_provider.clone(),
        )
    };

    let Some(transition) = transition else {
        return Ok(None);
    };

    // Push the chosen mode to the live CLI; on a CLI-reported rejection
    // for a known recoverable case (e.g. Claude Code's `auto` mode on a
    // non-auto-capable model), retry once with the adapter-supplied
    // fallback. Any other error — or a fallback that itself fails —
    // propagates and lights up an `error` envelope.
    let applied_mode = match &transition.query {
        Some(query) => {
            let q = query.read().await;
            match q.set_permission_mode(transition.target_mode.clone()).await {
                Ok(()) => transition.target_mode,
                Err(err) => {
                    let Some(fallback_mode) =
                        recoverable_fallback_mode(&runtime_provider, &transition.target_mode, &err)
                    else {
                        return Err(err);
                    };
                    warn!(
                        db_session_id,
                        target = permission_mode_wire(&transition.target_mode),
                        fallback = permission_mode_wire(&fallback_mode),
                        error = %err,
                        "post-plan-approval: target mode rejected, retrying with fallback"
                    );
                    q.set_permission_mode(fallback_mode.clone()).await?;
                    fallback_mode
                }
            }
        }
        None => {
            // Pending state — no live CLI; the queued mode will be passed
            // to the next spawn via Options.permission_mode.
            transition.target_mode
        }
    };

    let applied_wire = permission_mode_wire(&applied_mode);

    {
        let mut sessions = sdk_sessions.lock().await;
        if let Some(handle) = sessions.get_mut(&db_session_id) {
            apply_post_plan_mode_to_handle(handle, applied_mode);
        } else {
            warn!(
                db_session_id,
                "post-plan-approval: session handle disappeared after runtime mode transition"
            );
        }
    }

    WsSessionPersistence::update_permission_mode_static(write_pool, db_session_id, &applied_wire)
        .await;
    let envelope = WsEnvelope::new(
        "session",
        "mode.changed",
        serde_json::json!({ "mode": applied_wire }),
    );
    let _ = sender.send(Message::Text(String::from(envelope).into()));

    Ok(Some(applied_wire))
}

/// If the failed CLI request is one we know how to recover from for the
/// current provider, return the fallback mode. Returns `None` for any
/// non-`ControlRequestRejected` error or when the adapter has no
/// fallback registered for the failed mode.
fn recoverable_fallback_mode(
    runtime_provider: &str,
    failed_mode: &RuntimePermissionMode,
    err: &RuntimeError,
) -> Option<RuntimePermissionMode> {
    match err {
        RuntimeError::ControlRequestRejected { subtype, .. }
            if subtype == "set_permission_mode" =>
        {
            let fallback_wire = post_plan_approval_fallback_mode_wire(
                runtime_provider,
                &permission_mode_wire(failed_mode),
            )?;
            Some(parse_permission_mode(fallback_wire))
        }
        _ => None,
    }
}

struct PostPlanModeTransition {
    target_mode: RuntimePermissionMode,
    query: Option<RuntimeSessionHandle>,
}

fn plan_post_plan_mode_transition(handle: &SdkHandle) -> Option<PostPlanModeTransition> {
    let model_for_gate = handle
        .spawned_model
        .as_deref()
        .or(handle.desired_model.as_deref());
    let target_wire = post_plan_approval_mode_wire(&handle.runtime_provider, model_for_gate);
    let target_mode = parse_permission_mode(target_wire);

    if handle.spawned_permission_mode.as_ref() == Some(&target_mode) {
        debug!(
            target_mode = target_wire,
            "post-plan-approval: runtime already in target mode"
        );
        return None;
    }

    let query = match &handle.state {
        QueryState::Active { query, .. } => Some(query.clone()),
        QueryState::Pending(_) => None,
    };

    Some(PostPlanModeTransition { target_mode, query })
}

fn apply_post_plan_mode_to_handle(handle: &mut SdkHandle, target_mode: RuntimePermissionMode) {
    if let QueryState::Pending(options) = &mut handle.state {
        options.permission_mode = Some(target_mode.clone());
    }
    handle.desired_permission_mode = Some(target_mode.clone());
    handle.spawned_permission_mode = Some(target_mode.clone());
    handle.config.permission_mode = Some(target_mode);
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    use axum::extract::ws::Message;
    use serde_json::Value;
    use sqlx::SqlitePool;
    use tokio::sync::{mpsc, Mutex, RwLock};

    use super::transition_session_to_post_plan_mode;
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, RuntimeError, RuntimeMessageRx, RuntimePermissionMode,
    };
    use crate::domain::ws_session::handler::session_prompt::PermissionResponse;
    use crate::domain::ws_session::handler::{QueryState, SdkHandle, SdkSessions, SessionConfig};
    use crate::domain::ws_session::protocol::WsEnvelope;

    struct RecordingSession {
        modes: Arc<Mutex<Vec<RuntimePermissionMode>>>,
        message_rx: Option<RuntimeMessageRx>,
    }

    impl RecordingSession {
        fn new(modes: Arc<Mutex<Vec<RuntimePermissionMode>>>) -> Self {
            let (_tx, rx) = mpsc::channel(1);
            Self {
                modes,
                message_rx: Some(rx),
            }
        }
    }

    #[async_trait::async_trait]
    impl AgentRuntimeSession for RecordingSession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            self.message_rx.take().expect("message rx")
        }

        async fn session_id(&self) -> Option<String> {
            Some("runtime-session".to_string())
        }

        async fn stream_input(&self, _content: Value) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) {}

        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_permission_mode(
            &self,
            mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            self.modes.lock().await.push(mode);
            Ok(())
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE agent_sessions (\
             id INTEGER PRIMARY KEY, \
             permission_mode TEXT\
             )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO agent_sessions (id, permission_mode) VALUES (7, 'plan')")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    fn codex_plan_handle(modes: Arc<Mutex<Vec<RuntimePermissionMode>>>) -> SdkHandle {
        let (permission_tx, _permission_rx) = mpsc::channel::<PermissionResponse>(1);
        SdkHandle {
            state: QueryState::Active {
                query: Arc::new(RwLock::new(Box::new(RecordingSession::new(modes)))),
                permission_tx,
            },
            feature_id: 1,
            runtime_provider: "codex_cli".to_string(),
            desired_model: Some("gpt-5.5".to_string()),
            spawned_model: Some("gpt-5.5".to_string()),
            desired_permission_mode: Some(RuntimePermissionMode::Plan),
            spawned_permission_mode: Some(RuntimePermissionMode::Plan),
            desired_thinking_effort: None,
            spawned_thinking_effort: None,
            runtime_control_endpoint: None,
            resume_session_id: None,
            config: SessionConfig {
                cwd: PathBuf::from("/tmp/test"),
                canonical_cwd: PathBuf::from("/tmp/test"),
                permission_mode: Some(RuntimePermissionMode::Plan),
                thinking_effort: None,
                system_prompt: None,
                env: None,
            },
            manual_compact_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    /// A session whose `set_permission_mode` rejects `Auto` with the
    /// CLI-style "auto mode unavailable" message but accepts everything
    /// else. Mirrors the Sonnet-4.5 production failure mode.
    struct AutoRejectingSession {
        modes: Arc<Mutex<Vec<RuntimePermissionMode>>>,
        message_rx: Option<RuntimeMessageRx>,
    }

    impl AutoRejectingSession {
        fn new(modes: Arc<Mutex<Vec<RuntimePermissionMode>>>) -> Self {
            let (_tx, rx) = mpsc::channel(1);
            Self {
                modes,
                message_rx: Some(rx),
            }
        }
    }

    #[async_trait::async_trait]
    impl AgentRuntimeSession for AutoRejectingSession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            self.message_rx.take().expect("message rx")
        }
        async fn session_id(&self) -> Option<String> {
            Some("runtime-session".to_string())
        }
        async fn stream_input(&self, _content: Value) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn close(&mut self) {}
        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn set_permission_mode(
            &self,
            mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            if matches!(mode, RuntimePermissionMode::Auto) {
                // Mirrors the SDK's structured rejection: subtype is the
                // outbound command, message is the CLI's verbatim error.
                return Err(RuntimeError::ControlRequestRejected {
                    subtype: "set_permission_mode".to_string(),
                    message:
                        "Cannot set permission mode to auto: auto mode unavailable for this model"
                            .to_string(),
                });
            }
            self.modes.lock().await.push(mode);
            Ok(())
        }
        fn pid(&self) -> Option<u32> {
            None
        }
    }

    fn claude_code_plan_handle_with_auto_target(
        modes: Arc<Mutex<Vec<RuntimePermissionMode>>>,
    ) -> SdkHandle {
        // Seed the live Claude Code catalog so
        // `post_plan_approval_mode_wire(claude_code, sonnet) == "auto"` —
        // the Sonnet-4.5 production scenario where the catalog optimism
        // and the CLI's actual capability disagree.
        use crate::domain::agents::claude_code::seed_static_catalog_for_tests;
        use crate::domain::agents::runtime::ModelCatalogEntry;
        seed_static_catalog_for_tests(vec![ModelCatalogEntry {
            id: "default".to_string(),
            label: "Default".to_string(),
            description: None,
            supports_effort: None,
            supported_effort_levels: None,
            supports_adaptive_thinking: None,
            supports_fast_mode: None,
            supports_auto_mode: Some(true),
        }]);

        let (permission_tx, _permission_rx) = mpsc::channel::<PermissionResponse>(1);
        SdkHandle {
            state: QueryState::Active {
                query: Arc::new(RwLock::new(Box::new(AutoRejectingSession::new(modes)))),
                permission_tx,
            },
            feature_id: 1,
            runtime_provider: "claude_code".to_string(),
            desired_model: Some("sonnet".to_string()),
            spawned_model: Some("sonnet".to_string()),
            desired_permission_mode: Some(RuntimePermissionMode::Plan),
            spawned_permission_mode: Some(RuntimePermissionMode::Plan),
            desired_thinking_effort: None,
            spawned_thinking_effort: None,
            runtime_control_endpoint: None,
            resume_session_id: None,
            config: SessionConfig {
                cwd: PathBuf::from("/tmp/test"),
                canonical_cwd: PathBuf::from("/tmp/test"),
                permission_mode: Some(RuntimePermissionMode::Plan),
                thinking_effort: None,
                system_prompt: None,
                env: None,
            },
            manual_compact_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    #[tokio::test]
    async fn falls_back_to_accept_edits_when_cli_rejects_auto() {
        let pool = test_pool().await;
        let modes = Arc::new(Mutex::new(Vec::new()));
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        sdk_sessions.lock().await.insert(
            7,
            claude_code_plan_handle_with_auto_target(Arc::clone(&modes)),
        );
        let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();

        let changed = transition_session_to_post_plan_mode(&sdk_sessions, 7, &pool, &sender)
            .await
            .expect("fallback must succeed silently");

        // The orchestrator picked `auto` first, the CLI rejected it, so we
        // ended up in `acceptEdits` — surfaced via the return value, the
        // session handle, the DB, and the broadcast envelope.
        assert_eq!(changed.as_deref(), Some("acceptEdits"));
        assert_eq!(
            *modes.lock().await,
            vec![RuntimePermissionMode::AcceptEdits],
            "only the fallback mode should be recorded — the rejected `auto` is dropped"
        );

        let stored: String =
            sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE id = 7")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, "acceptEdits");

        let sessions = sdk_sessions.lock().await;
        let handle = sessions.get(&7).unwrap();
        assert_eq!(
            handle.spawned_permission_mode,
            Some(RuntimePermissionMode::AcceptEdits)
        );
        assert_eq!(
            handle.desired_permission_mode,
            Some(RuntimePermissionMode::AcceptEdits)
        );
        drop(sessions);

        let Message::Text(raw) = receiver.recv().await.unwrap() else {
            panic!("expected mode.changed text envelope");
        };
        let envelope: WsEnvelope = serde_json::from_str(&raw).unwrap();
        assert_eq!(envelope.action, "mode.changed");
        assert_eq!(
            envelope.payload["mode"], "acceptEdits",
            "the broadcast must reflect what the CLI actually accepted, not the original target"
        );
    }

    #[tokio::test]
    async fn transitions_codex_plan_approval_to_default_mode() {
        let pool = test_pool().await;
        let modes = Arc::new(Mutex::new(Vec::new()));
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
        sdk_sessions
            .lock()
            .await
            .insert(7, codex_plan_handle(Arc::clone(&modes)));
        let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();

        let changed = transition_session_to_post_plan_mode(&sdk_sessions, 7, &pool, &sender).await;

        assert_eq!(changed.unwrap().as_deref(), Some("default"));
        assert_eq!(*modes.lock().await, vec![RuntimePermissionMode::Default]);
        let stored: String =
            sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE id = 7")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, "default");
        let sessions = sdk_sessions.lock().await;
        let handle = sessions.get(&7).unwrap();
        assert_eq!(
            handle.spawned_permission_mode,
            Some(RuntimePermissionMode::Default)
        );
        assert_eq!(
            handle.desired_permission_mode,
            Some(RuntimePermissionMode::Default)
        );
        assert_eq!(
            handle.config.permission_mode,
            Some(RuntimePermissionMode::Default)
        );
        drop(sessions);

        let Message::Text(raw) = receiver.recv().await.unwrap() else {
            panic!("expected mode.changed text envelope");
        };
        let envelope: WsEnvelope = serde_json::from_str(&raw).unwrap();
        assert_eq!(envelope.action, "mode.changed");
        assert_eq!(envelope.payload["mode"], "default");
    }
}
