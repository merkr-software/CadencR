use axum::extract::ws::Message;

use super::super::protocol::*;
use super::{send_error, WsSender};
use crate::app_state::AppState;
use crate::domain::sessions::repository as sessions_repo;
use crate::domain::workspace::repository as workspace_repo;

pub(super) async fn handle_history_get(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let payload: HistoryGetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    match workspace_repo::get_prompt_history(&app_state.read_pool, payload.project_id).await {
        Ok(entries) => {
            let reply = WsEnvelope::session_reply(
                &envelope.id,
                &WsSessionEvent::HistoryResult(HistoryResultPayload { entries }),
            )
            .expect("session event payload should serialize");
            let _ = sender.send(Message::Text(String::from(reply).into()));
        }
        Err(e) => {
            send_error(sender, &envelope.id, "DB_ERROR", &e.to_string());
        }
    }
}

pub(super) async fn handle_history_add(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let payload: HistoryAddPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    match workspace_repo::add_prompt_entry(
        &app_state.write_pool,
        payload.project_id,
        &payload.content,
    )
    .await
    {
        Ok(added) => {
            let reply = WsEnvelope::session_reply(
                &envelope.id,
                &WsSessionEvent::HistoryAdded(HistoryAddedPayload { added }),
            )
            .expect("session event payload should serialize");
            let _ = sender.send(Message::Text(String::from(reply).into()));
        }
        Err(e) => {
            send_error(sender, &envelope.id, "DB_ERROR", &e.to_string());
        }
    }
}

pub(super) async fn handle_draft_get(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let payload: DraftGetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    match sessions_repo::get_draft(&app_state.read_pool, payload.session_id).await {
        Ok(draft) => {
            let reply = WsEnvelope::session_reply(
                &envelope.id,
                &WsSessionEvent::DraftResult(DraftResultPayload { draft }),
            )
            .expect("session event payload should serialize");
            let _ = sender.send(Message::Text(String::from(reply).into()));
        }
        Err(e) => {
            send_error(sender, &envelope.id, "DB_ERROR", &e.to_string());
        }
    }
}

pub(super) async fn handle_draft_save(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let payload: DraftSavePayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };

    match sessions_repo::save_draft(
        &app_state.write_pool,
        payload.session_id,
        payload.draft.as_deref(),
    )
    .await
    {
        Ok(()) => {
            let reply = WsEnvelope::session_reply(
                &envelope.id,
                &WsSessionEvent::DraftSaved(DraftSavedPayload { success: true }),
            )
            .expect("session event payload should serialize");
            let _ = sender.send(Message::Text(String::from(reply).into()));
        }
        Err(e) => {
            send_error(sender, &envelope.id, "DB_ERROR", &e.to_string());
        }
    }
}
