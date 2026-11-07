//! A plan whose agent process is gone is answered by the service: the client
//! only sends its decision, never a prompt of its own.
use super::support::*;
use tokio::time::{timeout, Duration};

async fn restored_plan_session(state: &AppState) -> (SdkSessions, mpsc::UnboundedReceiver<Value>) {
    let plan = serde_json::json!({
        "request_id": "plan-1",
        "tool_name": "ExitPlanMode",
        "tool_input": { "plan": "1. Do it" },
        "description": null, "pattern": null, "preview": null, "options": []
    });
    sqlx::query(
        "INSERT INTO agent_sessions (id, feature_id, status, runtime_provider, model, permission_mode, pending_permission)
         VALUES (1, 1, 'idle', 'claude-code', 'sonnet', 'plan', ?)",
    )
    .bind(plan.to_string())
    .execute(&state.write_pool)
    .await
    .unwrap();
    let (delivered, deliveries) = mpsc::unbounded_channel();
    let mut handle = make_active_handle(1, None);
    // Spawned after the plan was asked: it never saw that request.
    handle.state = QueryState::Active {
        query: Arc::new(RwLock::new(Box::new(RecordingRuntime { delivered }))),
        permission_tx: session_prompt::permission_response_channel().0,
    };
    let sessions = Arc::new(Mutex::new(HashMap::from([(1, handle)])));
    state.session_runtimes.bind_feature(1, 1, &sessions).await;
    (sessions, deliveries)
}

async fn answer(state: &AppState, sessions: &SdkSessions, payload: Value) -> Vec<WsEnvelope> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    dispatch_envelope(
        make_envelope("session", "permission.respond", payload),
        &tx,
        sessions,
        state,
    )
    .await;
    let mut replies = Vec::new();
    while let Ok(Message::Text(text)) = rx.try_recv() {
        replies.push(serde_json::from_str(&text).unwrap());
    }
    replies
}

fn delivered_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[tokio::test]
async fn approving_a_restored_plan_closes_it_and_tells_the_agent() {
    let state = make_test_app_state().await;
    let (sessions, mut deliveries) = restored_plan_session(&state).await;

    let replies = answer(
        &state,
        &sessions,
        serde_json::json!({ "session_id": "1", "request_id": "plan-1", "decision": "allow_once" }),
    )
    .await;

    assert!(
        replies.iter().any(|reply| reply.action == "acknowledged"),
        "{replies:?}"
    );
    assert!(
        replies.iter().all(|reply| reply.action != "error"),
        "{replies:?}"
    );
    let row = WsSessionPersistence::get_session_row(&state.read_pool, 1)
        .await
        .unwrap();
    assert!(!row.has_pending_user_input(), "the plan gate is closed");
    let prompt = timeout(Duration::from_secs(5), deliveries.recv())
        .await
        .expect("the agent is told the decision")
        .unwrap();
    assert!(
        delivered_text(&prompt).contains("approved your plan"),
        "{prompt}"
    );
    assert_ne!(
        row.permission_mode.as_deref(),
        Some("plan"),
        "an approval leaves plan mode"
    );
}

#[tokio::test]
async fn requesting_changes_on_a_restored_plan_sends_the_feedback() {
    let state = make_test_app_state().await;
    let (sessions, mut deliveries) = restored_plan_session(&state).await;

    answer(
        &state,
        &sessions,
        serde_json::json!({
            "session_id": "1", "request_id": "plan-1", "decision": "deny",
            "feedback": "Split step 1."
        }),
    )
    .await;

    let prompt = timeout(Duration::from_secs(5), deliveries.recv())
        .await
        .expect("the agent is told the decision")
        .unwrap();
    assert!(
        delivered_text(&prompt).contains("Split step 1."),
        "{prompt}"
    );
}
