//! The socket reaches only the native backend named by its authenticated grant.

use axum::extract::{Json, State};
use axum::http::StatusCode;
use futures::FutureExt;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio::task::JoinSet;

use super::emitter::Emitter;
use super::outbound::Outbound;
use super::subscriptions::{Cleanup, Started};
use crate::app_state::AppState;
use crate::domain::plugin_tabs::backend::events::Update;
use crate::domain::plugin_tabs::backend::models::PluginBackendRequest;
use crate::domain::plugin_tabs::grants::Grant;
use crate::domain::plugin_tabs::principal::PluginPrincipal;
use crate::domain::plugin_tabs::runtime_routes::{backend_launch, plugin_tab_self_backend_handler};
use crate::domain::ws_session::protocol::WsEnvelope;
use crate::error::AppError;

pub fn topic(params: &Value) -> Result<String, AppError> {
    let topic = params
        .get("topic")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if topic.is_empty() || topic.len() > 128 || topic.chars().any(char::is_control) {
        return Err(AppError::BadRequest(
            "topic must be 1–128 UTF-8 bytes without control characters".into(),
        ));
    }
    Ok(topic.to_owned())
}

pub async fn start(
    state: &AppState,
    grant: &Grant,
    topic: String,
    emitter: Emitter,
) -> Result<Started, AppError> {
    let launch = backend_launch(state, &PluginPrincipal::from(grant)).await?;
    let mut rx = state
        .plugin_tab_backends
        .subscribe(&state.plugin_tab_grants, launch)
        .await?;
    let run = async move {
        loop {
            let open = match rx.recv().await {
                Ok(Update::Event(event)) if event.topic == topic => {
                    emitter.emit("backend", "event", &*event)
                }
                Ok(Update::Event(_)) => true,
                Ok(Update::Resync) | Err(broadcast::error::RecvError::Lagged(_)) => {
                    emitter.resync()
                }
                Ok(Update::Error { code, message }) => emitter.error(&code, &message),
                Err(broadcast::error::RecvError::Closed) => false,
            };
            if !open {
                break;
            }
        }
    };
    Ok(Started {
        run: run.boxed(),
        cleanup: Cleanup::None,
    })
}

/// Work runs off the read loop. Revocation and unsubscribe remain responsive
/// while a slow backend call is pending. Dropping the socket aborts all waiters.
pub fn request(
    tasks: &mut JoinSet<()>,
    state: &AppState,
    grant: &Grant,
    out: &Outbound,
    envelope: &WsEnvelope,
) {
    while tasks.try_join_next().is_some() {}
    if tasks.len() >= cadencr_tab_backend::protocol::MAX_IN_FLIGHT {
        send_error(
            out,
            &envelope.id,
            AppError::coded(
                StatusCode::TOO_MANY_REQUESTS,
                "PLUGIN_BACKEND_BUSY",
                "too many pending backend calls",
            ),
        );
        return;
    }
    let body = match serde_json::from_value::<PluginBackendRequest>(envelope.payload.clone()) {
        Ok(body) => body,
        Err(error) => {
            send_error(out, &envelope.id, AppError::BadRequest(error.to_string()));
            return;
        }
    };
    let (state, principal, out, id) = (
        state.clone(),
        PluginPrincipal::from(grant),
        out.clone(),
        envelope.id.clone(),
    );
    tasks.spawn(async move {
        match plugin_tab_self_backend_handler(State(state), principal, Json(body)).await {
            Ok(Json(response)) => out.control(WsEnvelope::reply(
                &id,
                "plugin",
                "backend.response",
                json!(response),
            )),
            Err(error) => send_error(&out, &id, error),
        }
    });
}

pub fn problem(error: AppError) -> (&'static str, String) {
    let code = match &error {
        AppError::Coded { code, .. } => *code,
        AppError::BadRequest(_) => "BAD_REQUEST",
        AppError::NotFound(_) => "NOT_FOUND",
        AppError::Conflict(_) => "CONFLICT",
        _ => "INTERNAL_ERROR",
    };
    let message = if code == "INTERNAL_ERROR" {
        "Internal server error".into()
    } else {
        error.to_string()
    };
    (code, message)
}

fn send_error(out: &Outbound, id: &str, error: AppError) {
    let (code, message) = problem(error);
    out.control(WsEnvelope::reply(
        id,
        "plugin",
        "error",
        json!({ "code": code, "message": message }),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_are_opaque_but_bounded_and_cannot_choose_another_principal() {
        assert_eq!(
            topic(&json!({"topic":"clock.état", "plugin_id":"other", "feature_id":99})).unwrap(),
            "clock.état"
        );
        for value in [
            json!({}),
            json!({"topic":""}),
            json!({"topic":"é".repeat(65)}),
            json!({"topic":"a\nb"}),
        ] {
            assert!(topic(&value).is_err());
        }
    }
}
