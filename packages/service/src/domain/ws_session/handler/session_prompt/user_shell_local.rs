//! Cadencr-managed user shell execution and transcript streaming.

use crate::domain::ws_session::protocol::WsSessionEvent;
use std::path::PathBuf;
use std::time::Duration;

use axum::extract::ws::Message;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::domain::features::repository::{persist_tool_call_message, ToolCallMessage};
use crate::domain::ws_session::protocol::{SessionMessagePayload, WsEnvelope};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;
use crate::shared::terminal_shell::{
    run_terminal_shell_script_cancellable, terminal_output_channel,
};

use super::super::WsSender;
use super::user_shell_payload::ManagedShellPayload;

const OUTPUT_PERSIST_INTERVAL: Duration = Duration::from_secs(1);
const OUTPUT_STREAM_INTERVAL: Duration = Duration::from_millis(40);
const OUTPUT_STREAM_BATCH_BYTES: usize = 32 * 1024;

pub(super) struct LocalUserShellRequest {
    pub session_id: i64,
    pub feature_id: i64,
    pub command: String,
    pub cwd: PathBuf,
    pub write_pool: sqlx::SqlitePool,
    pub sender: WsSender,
    pub feature_senders: WsFeatureSenderRegistry,
    pub cancellation: CancellationToken,
}

struct ShellTranscript {
    row_id: i64,
    tool_use_id: String,
    stream_id: String,
}

struct ShellOutputContext {
    write_pool: sqlx::SqlitePool,
    feature_id: i64,
    sender: WsSender,
    feature_senders: WsFeatureSenderRegistry,
    row_id: i64,
    stream_id: String,
}

pub(super) async fn run_cadencr_managed_user_shell(
    request: LocalUserShellRequest,
) -> Result<(), String> {
    let cwd = request.cwd.to_string_lossy().into_owned();
    let payload = ManagedShellPayload::running(&request.command, &cwd);
    let transcript = create_transcript(&request, &payload).await?;
    publish_start(&request, &transcript, &payload).await;

    let (output_tx, output_rx) = terminal_output_channel();
    let output_context = ShellOutputContext {
        write_pool: request.write_pool.clone(),
        feature_id: request.feature_id,
        sender: request.sender.clone(),
        feature_senders: request.feature_senders.clone(),
        row_id: transcript.row_id,
        stream_id: transcript.stream_id.clone(),
    };
    let run = run_terminal_shell_script_cancellable(
        &request.command,
        &request.cwd,
        output_tx,
        request.cancellation.clone(),
    );
    let (run_result, mut payload) =
        tokio::join!(run, consume_output(output_context, payload, output_rx));
    match run_result {
        Ok(exit) => payload.finish(Some(exit.exit_code), None),
        Err(error) => payload.finish(None, Some(&error)),
    }

    let persist_result = persist_payload(&request.write_pool, transcript.row_id, &payload).await;
    publish_snapshot(&request, &transcript, &payload).await;
    publish_stop(&request, &transcript).await;
    persist_result
}

async fn create_transcript(
    request: &LocalUserShellRequest,
    payload: &ManagedShellPayload,
) -> Result<ShellTranscript, String> {
    let tool_use_id = format!("cadencr-user-shell-{}", uuid::Uuid::new_v4());
    let content = serde_json::to_string(payload)
        .map_err(|error| format!("Failed to encode user shell command: {error}"))?;
    let row_id = persist_tool_call_message(
        &request.write_pool,
        ToolCallMessage {
            session_id: request.session_id,
            tool_use_id: &tool_use_id,
            tool_name: "Bash",
            content: &content,
            parent_tool_use_id: None,
            model: None,
        },
    )
    .await
    .map_err(|error| format!("Failed to persist user shell command: {error}"))?;
    Ok(ShellTranscript {
        row_id,
        stream_id: format!("cadencr-user-shell:{tool_use_id}"),
        tool_use_id,
    })
}

async fn consume_output(
    context: ShellOutputContext,
    mut payload: ManagedShellPayload,
    mut output_rx: tokio::sync::mpsc::Receiver<String>,
) -> ManagedShellPayload {
    let mut persist_tick = tokio::time::interval(OUTPUT_PERSIST_INTERVAL);
    persist_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    persist_tick.tick().await;
    let mut stream_tick = tokio::time::interval(OUTPUT_STREAM_INTERVAL);
    stream_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    stream_tick.tick().await;
    let mut dirty = false;
    let mut pending_delta = String::new();
    loop {
        tokio::select! {
            output = output_rx.recv() => {
                let Some(line) = output else { break };
                let chunk = format!("{line}\n");
                payload.append_output(&chunk);
                pending_delta.push_str(&chunk);
                dirty = true;
                if pending_delta.len() >= OUTPUT_STREAM_BATCH_BYTES {
                    publish_output_delta(&context, std::mem::take(&mut pending_delta)).await;
                }
            }
            _ = stream_tick.tick(), if !pending_delta.is_empty() => {
                publish_output_delta(&context, std::mem::take(&mut pending_delta)).await;
            }
            _ = persist_tick.tick(), if dirty => {
                persist_live_payload(&context.write_pool, context.row_id, &payload).await;
                dirty = false;
            }
        }
    }
    if !pending_delta.is_empty() {
        publish_output_delta(&context, pending_delta).await;
    }
    if dirty {
        persist_live_payload(&context.write_pool, context.row_id, &payload).await;
    }
    payload
}

async fn publish_output_delta(context: &ShellOutputContext, chunk: String) {
    let delta = json!({ "__cadencr_output_delta": chunk }).to_string();
    publish_event(
        context.feature_id,
        &context.sender,
        &context.feature_senders,
        shell_delta_event(&context.stream_id, context.row_id, &delta),
    )
    .await;
}

async fn persist_live_payload(
    write_pool: &sqlx::SqlitePool,
    row_id: i64,
    payload: &ManagedShellPayload,
) {
    if let Err(error) = persist_payload(write_pool, row_id, payload).await {
        tracing::warn!(row_id, %error, "failed to persist live user shell output");
    }
}

async fn persist_payload(
    pool: &sqlx::SqlitePool,
    row_id: i64,
    payload: &ManagedShellPayload,
) -> Result<(), String> {
    let content = serde_json::to_string(payload)
        .map_err(|error| format!("Failed to encode user shell output: {error}"))?;
    sqlx::query("UPDATE agent_messages SET content = ? WHERE id = ?")
        .bind(content)
        .bind(row_id)
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to persist user shell output: {error}"))?;
    Ok(())
}

async fn publish_start(
    request: &LocalUserShellRequest,
    transcript: &ShellTranscript,
    payload: &ManagedShellPayload,
) {
    let input = serde_json::to_value(payload).expect("managed shell payload serializes");
    publish_event(
        request.feature_id,
        &request.sender,
        &request.feature_senders,
        shell_start_event(transcript, input),
    )
    .await;
}

async fn publish_snapshot(
    request: &LocalUserShellRequest,
    transcript: &ShellTranscript,
    payload: &ManagedShellPayload,
) {
    let snapshot = serde_json::to_string(payload).expect("managed shell payload serializes");
    publish_event(
        request.feature_id,
        &request.sender,
        &request.feature_senders,
        shell_delta_event(&transcript.stream_id, transcript.row_id, &snapshot),
    )
    .await;
}

async fn publish_stop(request: &LocalUserShellRequest, transcript: &ShellTranscript) {
    publish_event(
        request.feature_id,
        &request.sender,
        &request.feature_senders,
        shell_stop_event(&transcript.stream_id, transcript.row_id),
    )
    .await;
}

async fn publish_event(
    feature_id: i64,
    sender: &WsSender,
    feature_senders: &WsFeatureSenderRegistry,
    block: Value,
) {
    let envelope = WsEnvelope::session_event(&WsSessionEvent::Message(SessionMessagePayload {
        blocks: vec![block],
        seq: None,
    }))
    .expect("session event payload should serialize");
    feature_senders
        .send_and_mirror(
            feature_id,
            sender,
            Message::Text(String::from(envelope).into()),
        )
        .await;
}

fn shell_start_event(transcript: &ShellTranscript, input: Value) -> Value {
    json!({
        "type": "stream_event",
        "session_id": transcript.stream_id,
        "agent_message_id": transcript.row_id,
        "event": {
            "type": "content_block_start",
            "index": 0,
            "content_block": {
                "type": "tool_use",
                "id": transcript.tool_use_id,
                "name": "Bash",
                "input": input,
            }
        }
    })
}

fn shell_delta_event(stream_id: &str, row_id: i64, partial_json: &str) -> Value {
    json!({
        "type": "stream_event",
        "session_id": stream_id,
        "agent_message_id": row_id,
        "event": {
            "type": "content_block_delta",
            "index": 0,
            "delta": {
                "type": "input_json_delta",
                "partial_json": partial_json,
            }
        }
    })
}

fn shell_stop_event(stream_id: &str, row_id: i64) -> Value {
    json!({
        "type": "stream_event",
        "session_id": stream_id,
        "agent_message_id": row_id,
        "event": {
            "type": "content_block_stop",
            "index": 0,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_events_share_a_unique_stream_and_persisted_block_id() {
        let transcript = ShellTranscript {
            row_id: 9,
            tool_use_id: "tool-1".to_string(),
            stream_id: "shell:tool-1".to_string(),
        };
        let start = shell_start_event(&transcript, json!({ "command": "pwd" }));
        let delta = shell_delta_event(&transcript.stream_id, transcript.row_id, "{}");
        let stop = shell_stop_event(&transcript.stream_id, transcript.row_id);

        assert_eq!(start["session_id"], "shell:tool-1");
        assert_eq!(start["agent_message_id"], 9);
        assert_eq!(start["event"]["content_block"]["name"], "Bash");
        assert_eq!(delta["agent_message_id"], 9);
        assert_eq!(stop["agent_message_id"], 9);
    }
}
