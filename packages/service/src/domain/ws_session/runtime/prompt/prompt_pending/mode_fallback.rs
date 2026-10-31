use crate::domain::ws_session::protocol::WsSessionEvent;
use axum::extract::ws::Message;
use tracing::warn;

use super::PendingPromptContext;
use crate::domain::agents::adapter::AgentRuntimeAdapter;
use crate::domain::agents::permission_modes::permission_mode_wire;
use crate::domain::ws_session::protocol::{ModeChangedPayload, WsEnvelope};
use crate::domain::ws_session::runtime::helpers::send_warning;
use crate::domain::ws_session::runtime::state::QueryState;

/// Swap in the adapter's fallback when the runtime would silently drop the
/// requested permission mode on this model, then persist and announce it so
/// every viewer's mode chip matches what the runtime actually runs.
pub(in crate::domain::ws_session) async fn apply_spawn_mode_fallback(
    context: &mut PendingPromptContext,
    adapter: &dyn AgentRuntimeAdapter,
) {
    let Some(fallback) = adapter.spawn_mode_fallback(&context.options).await else {
        return;
    };
    let wire = permission_mode_wire(&fallback);
    warn!(
        context.db_session_id,
        requested = ?context.options.permission_mode,
        fallback = %wire,
        model = ?context.options.model,
        "permission mode unavailable for this model; spawning with the fallback"
    );
    let requested = context.config.permission_mode.clone();
    context.options.permission_mode = Some(fallback.clone());
    context.config.permission_mode = Some(fallback.clone());
    let mut adopted = false;
    {
        let mut sessions = context.sdk_sessions.lock().await;
        if let Some(handle) = sessions.get_mut(&context.db_session_id) {
            if handle.identity.same_instance(&context.handle_identity)
                && handle.desired_permission_mode == requested
                && handle.config.permission_mode == requested
            {
                adopted = true;
                handle.desired_permission_mode = Some(fallback.clone());
                handle.config.permission_mode = Some(fallback.clone());
                if let QueryState::Pending(options) = &mut handle.state {
                    options.permission_mode = Some(fallback);
                }
            }
        }
    }
    if !adopted {
        return;
    }
    let requested_wire = requested.as_ref().map(permission_mode_wire);
    match sqlx::query(
        "UPDATE agent_sessions SET permission_mode = ? WHERE id = ? AND permission_mode IS ?",
    )
    .bind(&wire)
    .bind(context.db_session_id)
    .bind(requested_wire)
    .execute(&context.app_state.write_pool)
    .await
    {
        Ok(result) if result.rows_affected() == 0 => return,
        Ok(_) => {}
        Err(error) => {
            send_warning(&context.sender, &context.envelope_id, "PERMISSION_MODE_PERSIST_FAILED", &format!("Runtime will use fallback mode {wire}, but the selected mode could not be saved: {error}"));
            return;
        }
    }
    let envelope = WsEnvelope::session_event(&WsSessionEvent::ModeChanged(ModeChangedPayload {
        mode: wire,
    }))
    .expect("mode changed payload should serialize");
    context
        .app_state
        .ws_feature_senders
        .send_and_mirror(
            context.feature_id,
            &context.sender,
            Message::Text(String::from(envelope).into()),
        )
        .await;
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Arc;

    use axum::extract::ws::Message;
    use serde_json::Value;
    use tokio::sync::{mpsc, Mutex};

    use super::super::PendingPromptContext;
    use super::apply_spawn_mode_fallback;
    use crate::domain::agents::adapter::{
        AgentRuntimeAdapter, AgentRuntimeSession, RuntimeError, RuntimePermissionMode,
        RuntimeSpawnConfig,
    };
    use crate::domain::agents::permission_modes::permission_mode_wire;
    use crate::domain::agents::runtime::ProviderCatalogEntry;
    use crate::domain::ws_session::handler::tests::support::make_test_app_state;
    use crate::domain::ws_session::runtime::state::{QueryState, SessionConfig};

    /// Adapter whose runtime can never honor `auto`.
    struct NoAutoAdapter;

    #[async_trait::async_trait]
    impl AgentRuntimeAdapter for NoAutoAdapter {
        fn catalog_entry(&self) -> ProviderCatalogEntry {
            unreachable!("catalog is not consulted by the spawn fallback")
        }

        async fn spawn(
            &self,
            _content: Value,
            _config: RuntimeSpawnConfig,
        ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
            unreachable!("the fallback runs before spawning")
        }

        async fn spawn_mode_fallback(
            &self,
            config: &RuntimeSpawnConfig,
        ) -> Option<RuntimePermissionMode> {
            (config.permission_mode == Some(RuntimePermissionMode::Auto))
                .then_some(RuntimePermissionMode::AcceptEdits)
        }
    }

    async fn pending_context(
        mode: RuntimePermissionMode,
    ) -> (PendingPromptContext, mpsc::UnboundedReceiver<Message>) {
        let app_state = make_test_app_state().await;
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, permission_mode) VALUES (7, 3, ?)",
        )
        .bind(permission_mode_wire(&mode))
        .execute(&app_state.write_pool)
        .await
        .expect("session row");
        let options = RuntimeSpawnConfig {
            cwd: PathBuf::from("/tmp/test"),
            permission_mode: Some(mode),
            model: Some("legacy-model".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let mut handle =
            crate::domain::ws_session::handler::tests::support::make_in_place_effort_handle(3);
        handle.state = QueryState::Pending(options.clone());
        handle.runtime_provider = "no-auto".into();
        handle.desired_model = options.model.clone();
        handle.desired_permission_mode = options.permission_mode.clone();
        handle.config = SessionConfig::from_runtime(&options, None);
        let handle_identity = handle.identity.clone();
        let sdk_sessions = Arc::new(Mutex::new(HashMap::from([(7, handle)])));
        let (sender, receiver) = mpsc::unbounded_channel();
        let context = PendingPromptContext {
            envelope_id: "env-1".to_string(),
            sender: sender.into(),
            sdk_sessions,
            app_state,
            db_session_id: 7,
            feature_id: 3,
            provider_id: "no-auto".to_string(),
            spawned_model: options.model.clone(),
            spawned_thinking_effort: None,
            config: SessionConfig::from_runtime(&options, None),
            options,
            payload: serde_json::from_value(serde_json::json!({
                "session_id": "7",
                "text": "hello",
            }))
            .expect("payload"),
            permission_tx: None,
            internal_replay: false,
            wait_for_delivery: false,
            spawn_claim: None,
            handle_identity,
        };
        (context, receiver)
    }

    async fn stored_mode(context: &PendingPromptContext) -> String {
        sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE id = 7")
            .fetch_one(&context.app_state.read_pool)
            .await
            .expect("stored mode")
    }

    #[tokio::test]
    async fn auto_is_downgraded_persisted_and_announced() {
        let (mut context, mut receiver) = pending_context(RuntimePermissionMode::Auto).await;

        apply_spawn_mode_fallback(&mut context, &NoAutoAdapter).await;

        let fallback = Some(RuntimePermissionMode::AcceptEdits);
        assert_eq!(context.options.permission_mode, fallback);
        assert_eq!(context.config.permission_mode, fallback);
        assert_eq!(stored_mode(&context).await, "acceptEdits");
        let sessions = context.sdk_sessions.lock().await;
        let handle = sessions.get(&7).unwrap();
        assert_eq!(handle.desired_permission_mode, fallback);
        assert_eq!(handle.config.permission_mode, fallback);
        drop(sessions);
        let query: crate::domain::agents::adapter::RuntimeSessionHandle = Arc::new(
            tokio::sync::RwLock::new(Box::new(crate::domain::agents::adapter::DummySession)),
        );
        assert!(
            super::super::active_session::insert_active_session(
                &context,
                query,
                mpsc::channel(1).0,
                None
            )
            .await
        );
        let sessions = context.sdk_sessions.lock().await;
        let changes =
            super::super::super::prompt_runtime_config::dispatch_changes(sessions.get(&7).unwrap());
        assert!(!changes.mode_changed);
        assert!(
            !changes.needs_respawn,
            "a fallback must not cause a respawn loop"
        );
        drop(sessions);
        let Ok(Message::Text(text)) = receiver.try_recv() else {
            panic!("expected a mode.changed envelope");
        };
        let envelope: Value = serde_json::from_str(&text).expect("envelope json");
        assert_eq!(envelope["action"], "mode.changed");
        assert_eq!(envelope["payload"]["mode"], "acceptEdits");
    }

    #[tokio::test]
    async fn a_mode_the_runtime_honors_is_left_alone() {
        let (mut context, mut receiver) = pending_context(RuntimePermissionMode::Plan).await;

        apply_spawn_mode_fallback(&mut context, &NoAutoAdapter).await;

        let requested = Some(RuntimePermissionMode::Plan);
        assert_eq!(context.options.permission_mode, requested);
        assert_eq!(context.config.permission_mode, requested);
        assert_eq!(stored_mode(&context).await, "plan");
        assert!(receiver.try_recv().is_err(), "no mode change to announce");
    }
    #[tokio::test]
    async fn newer_explicit_mode_survives_stale_spawn_fallback_without_notification() {
        let (mut context, mut receiver) = pending_context(RuntimePermissionMode::Auto).await;
        {
            let mut sessions = context.sdk_sessions.lock().await;
            let handle = sessions.get_mut(&7).unwrap();
            handle.desired_permission_mode = Some(RuntimePermissionMode::Plan);
            handle.config.permission_mode = Some(RuntimePermissionMode::Plan);
        }
        sqlx::query("UPDATE agent_sessions SET permission_mode = 'plan' WHERE id = 7")
            .execute(&context.app_state.write_pool)
            .await
            .unwrap();
        apply_spawn_mode_fallback(&mut context, &NoAutoAdapter).await;
        assert_eq!(
            context.options.permission_mode,
            Some(RuntimePermissionMode::AcceptEdits)
        );
        assert_eq!(stored_mode(&context).await, "plan");
        assert_eq!(
            context
                .sdk_sessions
                .lock()
                .await
                .get(&7)
                .unwrap()
                .desired_permission_mode,
            Some(RuntimePermissionMode::Plan)
        );
        assert!(receiver.try_recv().is_err());
    }
}
