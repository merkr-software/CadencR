//! Service runtime identity across reconnects, launch claims, and idle cleanup.

use super::support::*;

#[tokio::test]
async fn reconnect_cannot_replace_a_live_runtime_or_change_its_controls() {
    let state = make_test_app_state().await;
    let (owner, mut owner_rx) = mpsc::unbounded_channel();
    let owner_cell = crate::domain::ws_session::runtime::state::new_sdk_sessions();
    let id = init_session(&owner, &mut owner_rx, &owner_cell, &state, 1).await;
    let id: i64 = id.parse().unwrap();
    let handle = make_active_handle(1, Some("runtime-owned-by-service".into()));
    let query = match &handle.state {
        QueryState::Active { query, .. } => query.clone(),
        _ => unreachable!(),
    };
    owner_cell.lock().await.insert(id, handle);
    state.active_turns.begin_turn(id, &owner_cell).await;
    sqlx::query("UPDATE agent_sessions SET status = 'completed' WHERE id = ?")
        .bind(id)
        .execute(&state.write_pool)
        .await
        .unwrap();
    drop(owner_rx);
    drop(owner_cell);
    drop(owner);

    let (viewer, mut viewer_rx) = mpsc::unbounded_channel();
    let viewer_candidate = crate::domain::ws_session::runtime::state::new_sdk_sessions();
    let response = init_session_and_get_response(
        &viewer,
        &mut viewer_rx,
        &viewer_candidate,
        &state,
        SessionInitPayload {
            provider: None,
            model: Some("haiku".into()),
            thinking_effort: None,
            permission_mode: Some("bypassPermissions".into()),
            system_prompt: None,
            cwd: Some("/tmp/test".into()),
            feature_id: Some(1),
        },
    )
    .await;
    assert_eq!(response.model.as_deref(), Some("sonnet"));
    let persisted_permission: Option<String> =
        sqlx::query_scalar("SELECT permission_mode FROM agent_sessions WHERE id = ?")
            .bind(id)
            .fetch_one(&state.read_pool)
            .await
            .unwrap();
    assert_ne!(persisted_permission.as_deref(), Some("bypassPermissions"));
    assert_eq!(db_status(&state, id).await, "completed");
    let canonical = state.session_runtimes.get(id).await.unwrap();
    let sessions = canonical.lock().await;
    let QueryState::Active { query: current, .. } = &sessions.get(&id).unwrap().state else {
        panic!("live runtime replaced by init");
    };
    assert!(Arc::ptr_eq(current, &query));
    assert!(viewer_candidate.lock().await.is_empty());
}

#[tokio::test]
async fn init_during_launch_preserves_pending_options_for_cancelled_retry() {
    let state = make_test_app_state().await;
    let (owner, mut owner_rx) = mpsc::unbounded_channel();
    let cell = crate::domain::ws_session::runtime::state::new_sdk_sessions();
    let id = init_session(&owner, &mut owner_rx, &cell, &state, 1).await;
    let id: i64 = id.parse().unwrap();
    let expected = {
        let handles = cell.lock().await;
        let QueryState::Pending(options) = &handles.get(&id).unwrap().state else {
            unreachable!()
        };
        options.clone()
    };
    let launch = state.session_runtimes.claim_spawn(id).await;
    let (viewer, mut viewer_rx) = mpsc::unbounded_channel();
    let response = init_session_and_get_response(
        &viewer,
        &mut viewer_rx,
        &crate::domain::ws_session::runtime::state::new_sdk_sessions(),
        &state,
        SessionInitPayload {
            provider: None,
            model: Some("haiku".into()),
            thinking_effort: None,
            permission_mode: Some("bypassPermissions".into()),
            system_prompt: Some("replacement".into()),
            cwd: Some("/tmp/test".into()),
            feature_id: Some(1),
        },
    )
    .await;
    assert_eq!(response.model, expected.model);
    drop(launch); // Cancellation must release ownership without consuming config.
    let _retry = state.session_runtimes.claim_spawn(id).await;
    let handles = cell.lock().await;
    let QueryState::Pending(options) = &handles.get(&id).unwrap().state else {
        unreachable!()
    };
    assert_eq!(options.cwd, expected.cwd);
    assert_eq!(options.model, expected.model);
    assert_eq!(options.permission_mode, expected.permission_mode);
    assert_eq!(options.system_prompt, expected.system_prompt);
}

#[tokio::test]
async fn last_viewer_detach_releases_pending_runtime_cell() {
    let state = make_test_app_state().await;
    let (viewer, mut rx) = mpsc::unbounded_channel();
    let candidate = crate::domain::ws_session::runtime::state::new_sdk_sessions();
    let id = init_session(&viewer, &mut rx, &candidate, &state, 1)
        .await
        .parse()
        .unwrap();
    drop(candidate);
    state
        .session_runtimes
        .prune_unobserved(&state.ws_feature_senders)
        .await;
    assert!(state.session_runtimes.get(id).await.is_some());
    state.ws_feature_senders.unregister_sender(&viewer).await;
    state
        .session_runtimes
        .prune_unobserved(&state.ws_feature_senders)
        .await;
    assert!(state.session_runtimes.get(id).await.is_none());
}

struct ClosingRuntime {
    closed: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl crate::domain::agents::adapter::AgentRuntimeSession for ClosingRuntime {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        mpsc::channel(1).1
    }
    async fn session_id(&self) -> Option<String> {
        Some("tracked-runtime".into())
    }
    async fn stream_input(
        &self,
        _: Value,
    ) -> Result<(), crate::domain::agents::adapter::RuntimeError> {
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), crate::domain::agents::adapter::RuntimeError> {
        Ok(())
    }
    async fn close(&mut self) -> Result<(), crate::domain::agents::adapter::RuntimeError> {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    async fn set_model(&self, _: &str) -> Result<(), crate::domain::agents::adapter::RuntimeError> {
        Ok(())
    }
    async fn set_permission_mode(
        &self,
        _: crate::domain::agents::adapter::RuntimePermissionMode,
    ) -> Result<(), crate::domain::agents::adapter::RuntimeError> {
        Ok(())
    }
    async fn set_thinking_effort(
        &self,
        _: Option<String>,
    ) -> Result<(), crate::domain::agents::adapter::RuntimeError> {
        Ok(())
    }
    fn pid(&self) -> Option<u32> {
        None
    }
}

#[tokio::test]
async fn feature_retirement_closes_exact_runtime_without_waiting_unrelated_provider() {
    let state = make_test_app_state().await;
    let (sender, mut rx) = mpsc::unbounded_channel();
    let first = crate::domain::ws_session::runtime::state::new_sdk_sessions();
    let id: i64 = init_session(&sender, &mut rx, &first, &state, 1)
        .await
        .parse()
        .unwrap();
    let second = crate::domain::ws_session::runtime::state::new_sdk_sessions();
    init_session(&sender, &mut rx, &second, &state, 2).await;
    let _unrelated_provider = second.lock().await;
    let closed = Arc::new(AtomicBool::new(false));
    let mut handle = make_active_handle(1, None);
    let QueryState::Active { query, .. } = &mut handle.state else {
        unreachable!()
    };
    *query = Arc::new(RwLock::new(Box::new(ClosingRuntime {
        closed: closed.clone(),
    })));
    first.lock().await.insert(id, handle);
    tokio::time::timeout(
        std::time::Duration::from_millis(100),
        state.session_runtimes.retire_feature(1),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
    assert!(state.session_runtimes.get(id).await.is_none());
    assert!(first.lock().await.is_empty());
}

#[tokio::test]
async fn older_idle_reader_cannot_close_replacement_in_same_cell() {
    let state = make_test_app_state().await;
    let id = 41;
    insert_running_session(&state, id, 1).await;
    let cell = crate::domain::ws_session::runtime::state::new_sdk_sessions();
    cell.lock()
        .await
        .insert(id, make_active_handle(1, Some("old-runtime".into())));
    let (events, rx) = mpsc::channel(8);
    let (sender, mut output) = mpsc::unbounded_channel();
    spawn_test_stream_reader(&state, id, 1, rx, sender, cell.clone(), "claude_code");
    events.send(Ok(result_event())).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let Some(Message::Text(text)) = output.recv().await else {
                continue;
            };
            let event: WsEnvelope = serde_json::from_str(&text).unwrap();
            if event.action == "ended" {
                break;
            }
        }
    })
    .await
    .unwrap();
    let closed = Arc::new(AtomicBool::new(false));
    let mut replacement = make_active_handle(1, None);
    let QueryState::Active { query, .. } = &mut replacement.state else {
        unreachable!()
    };
    *query = Arc::new(RwLock::new(Box::new(ClosingRuntime {
        closed: closed.clone(),
    })));
    cell.lock().await.insert(id, replacement);
    drop(output);
    tokio::time::sleep(std::time::Duration::from_millis(650)).await;
    assert!(!closed.load(std::sync::atomic::Ordering::SeqCst));
    assert!(matches!(
        cell.lock().await.get(&id).unwrap().state,
        QueryState::Active { .. }
    ));
    drop(events);
}

#[tokio::test]
async fn cancelled_compact_start_releases_pending_reservation() {
    let state = make_test_app_state().await;
    let (sender, mut rx) = mpsc::unbounded_channel();
    let cell = crate::domain::ws_session::runtime::state::new_sdk_sessions();
    let id: i64 = init_session(&sender, &mut rx, &cell, &state, 1)
        .await
        .parse()
        .unwrap();
    let pending = cell
        .lock()
        .await
        .get(&id)
        .unwrap()
        .manual_compact_spawn_pending
        .clone();
    let (_, reservation) = super::super::session_compact_lifecycle::begin_compact(&cell, id, None)
        .await
        .unwrap();
    let task = tokio::spawn(async move {
        let _reservation = reservation;
        std::future::pending::<()>().await;
    });
    assert!(pending.load(std::sync::atomic::Ordering::SeqCst));
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(!pending.load(std::sync::atomic::Ordering::SeqCst));
}
