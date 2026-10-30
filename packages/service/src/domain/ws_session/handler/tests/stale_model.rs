//! A conversation's model must follow its session row, not whichever
//! in-memory handle a prompt lands on. Handles snapshot the selection at
//! `session.init`, and a switch made through another connection, a schedule
//! pin or the owning connection leaves the others behind.

use super::support::*;

/// A provider with no adapter: the spawn stops right after the prompt was
/// dispatched to the handle, before any runtime starts.
const UNAVAILABLE_PROVIDER: &str = "unavailable_provider";

async fn persist_selection(app_state: &AppState, db_id: i64, model: &str) {
    sqlx::query("UPDATE agent_sessions SET runtime_provider = ?, model = ? WHERE id = ?")
        .bind(UNAVAILABLE_PROVIDER)
        .bind(model)
        .bind(db_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap();
}

fn pending_model(sessions: &HashMap<i64, SdkHandle>, db_id: i64) -> Option<String> {
    match &sessions.get(&db_id).unwrap().state {
        QueryState::Pending(options) => options.model.clone(),
        QueryState::Active { .. } => panic!("expected a pending handle"),
    }
}

#[tokio::test]
async fn prompt_from_a_stale_handle_spawns_on_the_persisted_model() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let app_state = make_test_app_state().await;
    let session_id = init_session(&tx, &mut rx, &sdk_sessions, &app_state, 1).await;
    let db_id: i64 = session_id.parse().unwrap();
    {
        let mut sessions = sdk_sessions.lock().await;
        let handle = sessions.get_mut(&db_id).unwrap();
        handle.runtime_provider = UNAVAILABLE_PROVIDER.to_string();
        handle.desired_claude_profile = None;
        handle.desired_model = Some("model-at-init".to_string());
        let QueryState::Pending(options) = &mut handle.state else {
            panic!("expected a pending handle");
        };
        options.model = Some("model-at-init".to_string());
    }
    // Switched elsewhere after this connection initialized.
    persist_selection(&app_state, db_id, "model-picked-later").await;

    let envelope = make_envelope(
        "session",
        "prompt.send",
        serde_json::json!({ "session_id": session_id, "text": "hello" }),
    );
    dispatch_envelope(envelope, &tx, &sdk_sessions, &app_state).await;

    let sessions = sdk_sessions.lock().await;
    assert_eq!(
        sessions.get(&db_id).unwrap().desired_model.as_deref(),
        Some("model-picked-later")
    );
    // The failed dispatch leaves the handle ready to spawn the same selection
    // again, rather than with emptied options that run the provider default.
    assert_eq!(
        pending_model(&sessions, db_id).as_deref(),
        Some("model-picked-later")
    );
}

/// An owner connection whose runtime outlived its turn, on "model-at-init".
async fn idle_owner(app_state: &AppState) -> (SdkSessions, i64) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let owner_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let session_id = init_session(&tx, &mut rx, &owner_sessions, app_state, 1).await;
    let db_id: i64 = session_id.parse().unwrap();
    {
        let mut sessions = owner_sessions.lock().await;
        let handle = sessions.get_mut(&db_id).unwrap();
        let (permission_tx, _permission_rx) =
            mpsc::channel::<session_prompt::PermissionResponse>(1);
        handle.state = QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(InPlaceEffortSession::new()))),
            permission_tx,
        };
        handle.runtime_provider = UNAVAILABLE_PROVIDER.to_string();
        handle.desired_model = Some("model-at-init".to_string());
        handle.spawned_model = Some("model-at-init".to_string());
    }
    app_state
        .active_turns
        .begin_turn(db_id, &owner_sessions)
        .await;
    (owner_sessions, db_id)
}

/// Steer a scheduled prompt into the owner. The stub runtime never confirms
/// delivery, so a steered prompt is abandoned after a moment.
async fn dispatch_scheduled(app_state: &AppState, db_id: i64) -> Option<Result<(), String>> {
    let dispatch = crate::domain::ws_session::runtime::application::dispatch_control_prompt(
        app_state, 1, db_id, "check", false,
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), dispatch)
        .await
        .ok()
        .map(|result| {
            result
                .map(|outcome| outcome.delivery_confirmed())
                .map_err(|error| error.to_string())
        })
}

/// Scheduled prompts are steered into the owner's runtime. One still on an
/// older model is closed so the prompt runs on the persisted selection.
#[tokio::test]
async fn scheduled_prompt_respawns_an_idle_owner_still_on_an_older_model() {
    let app_state = make_test_app_state().await;
    let (owner_sessions, db_id) = idle_owner(&app_state).await;
    persist_selection(&app_state, db_id, "model-picked-later").await;

    // The owner was closed, so the prompt fell back to a control-map spawn,
    // which the unavailable provider then refuses.
    let result = dispatch_scheduled(&app_state, db_id).await;
    assert!(matches!(result, Some(Err(_))), "{result:?}");

    let sessions = owner_sessions.lock().await;
    let handle = sessions.get(&db_id).unwrap();
    assert!(matches!(handle.state, QueryState::Pending(_)));
    assert_eq!(handle.desired_model.as_deref(), Some("model-picked-later"));
}

#[tokio::test]
async fn owner_already_on_the_persisted_model_is_steered_without_a_respawn() {
    let app_state = make_test_app_state().await;
    let (owner_sessions, db_id) = idle_owner(&app_state).await;
    persist_selection(&app_state, db_id, "model-at-init").await;

    dispatch_scheduled(&app_state, db_id).await;

    let sessions = owner_sessions.lock().await;
    assert!(matches!(
        sessions.get(&db_id).unwrap().state,
        QueryState::Active { .. }
    ));
}

#[tokio::test]
async fn owner_in_the_middle_of_a_turn_is_never_cut_off() {
    let app_state = make_test_app_state().await;
    let (owner_sessions, db_id) = idle_owner(&app_state).await;
    persist_selection(&app_state, db_id, "model-picked-later").await;
    app_state.session_status_tx.broadcast(
        db_id,
        1,
        crate::domain::session_status::AgentStatus::Agent,
        None,
    );

    dispatch_scheduled(&app_state, db_id).await;

    let sessions = owner_sessions.lock().await;
    let handle = sessions.get(&db_id).unwrap();
    assert!(matches!(handle.state, QueryState::Active { .. }));
    assert_eq!(handle.desired_model.as_deref(), Some("model-at-init"));
}
