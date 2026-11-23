//! Answering a question no live runtime holds.
//!
//! A provider that asks without waiting (Codex `request_user_input_async`)
//! leaves a question that outlives the runtime that asked it: after a restart
//! its persisted form still shows while the session's runtime is not spawned
//! yet. Answering it reached nothing ("Session not yet active"). When the
//! provider takes such an answer as ordinary input, the service closes the
//! gate and sends the provider's prompt for it as the conversation's next
//! prompt, which starts the agent again. The client only sends its answers,
//! like for a live gate.

use crate::domain::agents::adapter::RuntimePermissionResponse;
use crate::domain::ws_session::protocol::PermissionRespondPayload;
use crate::domain::ws_session::runtime::output::{CommandError, CommandOutput};
use crate::domain::ws_session::runtime::state::SdkSessions;

use super::permission::PermissionResponseOutcome;
use super::permission_context::PermissionContext;
use super::restored_gate::{close_and_follow_up, FollowUp, RestoredGate};

/// `respond_claimed`'s failure when the session's runtime is not running.
const NO_RUNTIME: &str = "INVALID_STATE";

/// Answer a claimed question; the service answers it when no runtime runs
/// and the provider takes the answer as input.
pub(super) async fn respond_claimed_question(
    context: &PermissionContext<'_>,
    sdk_sessions: &SdkSessions,
    payload: PermissionRespondPayload,
    output: &CommandOutput,
    db_session_id: i64,
) -> Result<PermissionResponseOutcome, CommandError> {
    let restored = payload.clone();
    match super::permission::respond_claimed(context, sdk_sessions, payload, output, db_session_id)
        .await
    {
        Err(error) if error.code == NO_RUNTIME => {
            let sessions = super::super::control_policy::resolve_owner_sessions(
                sdk_sessions,
                context.active_turns,
                db_session_id,
            )
            .await;
            answer_unheld_question(context, &sessions, restored, output, db_session_id, error).await
        }
        result => result,
    }
}

/// The provider's prompt for `payload` (`Ok(None)`: nothing to tell); `None`
/// when the provider must hold the question itself.
fn unheld_answer(
    provider: &str,
    payload: &PermissionRespondPayload,
) -> Option<Result<Option<String>, CommandError>> {
    let adapter = crate::domain::agents::providers::runtime_adapter(provider)?;
    let response = RuntimePermissionResponse {
        request_id: payload.request_id.clone(),
        decision: payload
            .decision
            .to_runtime_decision(payload.option_id.as_deref()),
        option_id: payload.option_id.clone(),
        feedback: payload.feedback.clone(),
        updated_input: payload.updated_input.clone(),
    };
    let answer = adapter.unheld_question_prompt(&response)?;
    Some(answer.map_err(|error| CommandError::new("INVALID_ANSWER", error.to_string())))
}

/// Close the question and send the provider's prompt for its answer.
async fn answer_unheld_question(
    context: &PermissionContext<'_>,
    sdk_sessions: &SdkSessions,
    payload: PermissionRespondPayload,
    output: &CommandOutput,
    session_id: i64,
    not_held: CommandError,
) -> Result<PermissionResponseOutcome, CommandError> {
    let Some(app_state) = context.app_state else {
        return Err(not_held);
    };
    let Some((feature_id, provider)) = sdk_sessions
        .lock()
        .await
        .get(&session_id)
        .map(|handle| (handle.feature_id, handle.runtime_provider.clone()))
    else {
        return Err(not_held);
    };
    let Some(text) = unheld_answer(&provider, &payload) else {
        return Err(not_held);
    };
    let follow_up = text?.map(|text| FollowUp {
        text,
        not_delivered_code: "QUESTION_ANSWER_NOT_DELIVERED",
        not_delivered: "Your answer",
    });
    let gate = RestoredGate {
        session_id,
        feature_id,
        payload: &payload,
        name: "question",
    };
    close_and_follow_up(context, app_state, output, gate, follow_up).await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use tokio::sync::{mpsc, Mutex, RwLock};

    use crate::app_state::AppState;
    use crate::domain::agents::adapter::RuntimeSpawnConfig;
    use crate::domain::ws_session::handler::tests::support::{
        make_active_handle, make_test_app_state, RecordingRuntime,
    };
    use crate::domain::ws_session::persistence::WsSessionPersistence;
    use crate::domain::ws_session::runtime::application::{respond_permission, PermissionContext};
    use crate::domain::ws_session::runtime::output::{CommandOutput, SessionOutput};
    use crate::domain::ws_session::runtime::prompt::permission_response_channel;
    use crate::domain::ws_session::runtime::state::{QueryState, SdkSessions};
    use tokio::time::{timeout, Duration};

    const QUESTION: &str = "codex_async_question_call_restart";

    /// A session restarted with a question still pending: its runtime is not
    /// spawned yet.
    async fn restarted_session(provider: &str) -> (AppState, SdkSessions) {
        let state = make_test_app_state().await;
        let question = serde_json::json!({
            "request_id": QUESTION, "tool_name": "AskUserQuestion",
            "tool_input": {"questions": [{"question": "Open the QA instance?"}]}
        });
        sqlx::query("INSERT INTO agent_sessions (id, feature_id, status, runtime_provider, pending_questions) VALUES (1, 1, 'completed', ?, ?)")
            .bind(provider)
            .bind(question.to_string())
            .execute(&state.write_pool)
            .await
            .unwrap();
        let mut handle = make_active_handle(1, None);
        handle.runtime_provider = provider.to_string();
        handle.state = QueryState::Pending(RuntimeSpawnConfig::default());
        let sessions = Arc::new(Mutex::new(HashMap::from([(1, handle)])));
        state.session_runtimes.bind_feature(1, 1, &sessions).await;
        (state, sessions)
    }

    async fn answer(
        state: &AppState,
        sessions: &SdkSessions,
        answers: serde_json::Value,
    ) -> Result<(), crate::domain::ws_session::runtime::output::CommandError> {
        let context = PermissionContext::builder()
            .read_pool(&state.read_pool)
            .write_pool(&state.write_pool)
            .pending_gates(&state.pending_gates)
            .active_turns(&state.active_turns)
            .session_status(&state.session_status_tx)
            .feature_senders(&state.ws_feature_senders)
            .feature_events(&state.feature_events_tx)
            .app_state(state)
            .build();
        let payload = serde_json::from_value(serde_json::json!({
            "session_id": "1", "request_id": QUESTION, "decision": "allow_once",
            "updated_input": {
                "questions": [{"question": "Open the QA instance?"}],
                "answers": answers
            }
        }))
        .unwrap();
        let output = CommandOutput {
            recipient: SessionOutput::headless(),
            correlation_id: String::new(),
        };
        respond_permission(&context, sessions, payload, &output)
            .await
            .map(|_| ())
    }

    async fn question_pending(state: &AppState) -> bool {
        WsSessionPersistence::get_session_row(&state.read_pool, 1)
            .await
            .unwrap()
            .unwrap()
            .has_pending_user_input()
    }

    #[tokio::test]
    async fn an_answer_with_no_runtime_running_closes_the_question_and_starts_the_agent() {
        let (state, sessions) = restarted_session("codex_cli").await;

        answer(&state, &sessions, serde_json::json!([["Yes"]]))
            .await
            .unwrap();

        assert!(!question_pending(&state).await, "the question is closed");
        // The delivery task has not run yet (single-threaded test runtime):
        // stand in for the runtime the service starts, so no CLI is spawned.
        let (delivered, mut deliveries) = mpsc::unbounded_channel();
        {
            let mut map = sessions.try_lock().unwrap();
            let handle = map.get_mut(&1).unwrap();
            handle.runtime_provider = crate::domain::agents::runtime::DEFAULT_PROVIDER.into();
            handle.state = QueryState::Active {
                query: Arc::new(RwLock::new(Box::new(RecordingRuntime { delivered }))),
                permission_tx: permission_response_channel().0,
            };
        }
        let prompt = timeout(Duration::from_secs(5), deliveries.recv())
            .await
            .expect("the agent receives the answer")
            .unwrap();
        let text = prompt
            .as_str()
            .map_or_else(|| prompt.to_string(), str::to_string);
        assert!(text.contains("Open the QA instance?"), "{text}");
        assert!(text.contains("Yes"), "{text}");
    }

    #[tokio::test]
    async fn a_provider_that_must_hold_its_question_still_says_it_is_not_running() {
        let (state, sessions) =
            restarted_session(crate::domain::agents::claude_code::PROVIDER_ID).await;

        let error = answer(&state, &sessions, serde_json::json!([["Yes"]]))
            .await
            .unwrap_err();

        assert_eq!(error.code, "INVALID_STATE");
        assert!(question_pending(&state).await, "the question stays open");
    }

    /// The provider validates the answer as for a live question: an empty one
    /// is refused and the question stays open to answer again.
    #[tokio::test]
    async fn an_answer_the_provider_refuses_leaves_the_question_open() {
        let (state, sessions) = restarted_session("codex_cli").await;

        let error = answer(&state, &sessions, serde_json::json!([[" "]]))
            .await
            .unwrap_err();

        assert_eq!(error.code, "INVALID_ANSWER");
        assert!(question_pending(&state).await, "the question stays open");
    }
}
