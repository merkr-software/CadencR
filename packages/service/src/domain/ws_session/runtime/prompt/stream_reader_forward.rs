use crate::domain::ws_session::protocol::WsSessionEvent;
use crate::domain::ws_session::runtime::output::OutputTarget;
use axum::extract::ws::Message;
use tracing::{debug, error};

use crate::domain::agents::adapter::RuntimeStreamStatus;
use crate::domain::agents::adapter::{RuntimeEvent, RuntimeSlashCommandKind};
use crate::domain::ws_session::protocol::{
    CommandsUpdatedPayload, SessionStreamStatusPayload, SlashCommandKindPayload,
    SlashCommandPayload, StreamStatusState, WsEnvelope, WsSessionAction,
};

use super::prompt_receipt::prompt_received_envelope;
use super::stream_reader_task::{StreamReaderState, StreamReaderTask};

impl StreamReaderTask {
    /// Send `msg` to this turn's owner socket and mirror it to any *other*
    /// devices viewing the same feature. Others are mirrored first so the owner
    /// send can move `msg` without a clone; in the common single-viewer case
    /// `broadcast_others` is a no-op. Returns `true` when the owner socket is
    /// gone, so callers can stop the loop exactly as a bare `send().is_err()`.
    pub(in crate::domain::ws_session) async fn send_and_mirror(&self, msg: Message) -> bool {
        self.feature_senders
            .send_and_mirror(self.feature_id, &self.sender, msg)
            .await
    }
}

pub(in crate::domain::ws_session) enum ForwardOutcome {
    Forwarded,
    NotHandled,
    SenderClosed,
    Suppressed,
}

pub(in crate::domain::ws_session) async fn forward_immediate_event(
    task: &StreamReaderTask,
    state: &mut StreamReaderState,
    runtime_event: &RuntimeEvent,
) -> ForwardOutcome {
    if let Some(message_uuid) = runtime_event.prompt_received_client_message_id() {
        if !persist_prompt_receipt(task, state, message_uuid).await {
            return ForwardOutcome::Suppressed;
        }
        // Mirror to every viewer, not just the turn owner. With cross-device
        // steering the device that SENT this prompt may not be the turn owner
        // (e.g. the host steers a turn owned by a now-disconnected phone), so
        // sending the ack only to the owner socket would leave the real sender's
        // message stuck pending. Other viewers ignore an unknown
        // canonical message UUID, so mirroring is safe.
        return send_envelope(
            task,
            WsSessionAction::PromptReceived.as_str(),
            prompt_received_envelope(
                message_uuid.to_string(),
                crate::domain::ws_session::protocol::PromptReceiptState::ReceivedAgent,
            ),
            true,
        )
        .await;
    }

    if let Some(commands) = runtime_event.slash_commands_updated() {
        return send_envelope(
            task,
            "commands.updated",
            WsEnvelope::new(
                "commands",
                "updated",
                serde_json::to_value(CommandsUpdatedPayload {
                    commands: commands
                        .iter()
                        .map(|command| SlashCommandPayload {
                            name: command.name.clone(),
                            description: command.description.clone(),
                            kind: slash_command_kind_payload(command.kind),
                        })
                        .collect(),
                })
                .unwrap(),
            ),
            false,
        )
        .await;
    }

    if let Some(status) = runtime_event.stream_status() {
        return send_envelope(
            task,
            WsSessionAction::StreamStatus.as_str(),
            WsEnvelope::session_event(&WsSessionEvent::StreamStatus(stream_status_payload(status)))
                .expect("stream status payload should serialize"),
            true,
        )
        .await;
    }

    ForwardOutcome::NotHandled
}

async fn persist_prompt_receipt(
    task: &StreamReaderTask,
    state: &mut StreamReaderState,
    message_uuid: &str,
) -> bool {
    match crate::domain::sessions::user_messages::update_delivery_state(
        &task.write_pool,
        task.db_session_id,
        message_uuid,
        "received_agent",
    )
    .await
    {
        Ok(true) => {
            if !state
                .received_prompt_message_uuids
                .iter()
                .any(|received| received == message_uuid)
            {
                state
                    .received_prompt_message_uuids
                    .push(message_uuid.to_string());
            }
            true
        }
        Ok(false) => {
            error!(task.db_session_id, %message_uuid, "ignored receipt for an unknown canonical prompt");
            false
        }
        Err(error) => {
            error!(task.db_session_id, error = %error, "failed to persist prompt receipt");
            false
        }
    }
}

/// Forward `envelope` to the turn's owner. When `mirror` is set, also relay it
/// to other devices viewing the feature. Stream content (`stream_status`) and
/// the `prompt_received` ack are mirrored (the sender may be a different device
/// than the turn owner); `commands.updated` is owner-only.
async fn send_envelope(
    task: &StreamReaderTask,
    label: &'static str,
    envelope: WsEnvelope,
    mirror: bool,
) -> ForwardOutcome {
    let msg = Message::Text(String::from(envelope).into());
    let owner_closed = if mirror {
        task.send_and_mirror(msg).await
    } else {
        task.sender.send(msg).is_err()
    };
    if owner_closed {
        debug!(
            task.db_session_id,
            "WebSocket sender closed during {label} forward"
        );
        return ForwardOutcome::SenderClosed;
    }
    ForwardOutcome::Forwarded
}

fn slash_command_kind_payload(kind: RuntimeSlashCommandKind) -> SlashCommandKindPayload {
    match kind {
        RuntimeSlashCommandKind::Command => SlashCommandKindPayload::Command,
        RuntimeSlashCommandKind::Skill => SlashCommandKindPayload::Skill,
    }
}

fn stream_status_payload(status: &RuntimeStreamStatus) -> SessionStreamStatusPayload {
    match status {
        RuntimeStreamStatus::Degraded { reason } => SessionStreamStatusPayload {
            state: StreamStatusState::Degraded,
            reason: Some(reason.clone()),
        },
        RuntimeStreamStatus::Recovered => SessionStreamStatusPayload {
            state: StreamStatusState::Recovered,
            reason: None,
        },
    }
}
