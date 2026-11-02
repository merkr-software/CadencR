use crate::domain::ws_session::protocol::WsSessionEvent;
use std::time::{Duration, Instant};

use tracing::{debug, info, warn};

use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeContentBlock, RuntimeContentDelta, RuntimeError, RuntimeStreamEvent,
};
use crate::domain::agents::providers::runtime_session_finished_text;

/// Safety cap: auto-naming should complete in seconds. If the provider hasn't
/// emitted a terminal event by then, bail out rather than hang the skeleton.
const AUTO_NAME_DEADLINE: Duration = Duration::from_secs(30);

/// Poll interval for the fallback "session finished" reconciler — matches the
/// polling interval used by stream_reader so OpenCode short-turn completions get picked
/// up when no explicit Result event arrives.
const AUTO_NAME_RECV_TIMEOUT: Duration = Duration::from_millis(500);

/// Why the drain loop stopped. Logged at INFO on exit so operators can
/// diagnose "skeleton cleared with no name" incidents without re-running
/// with debug logging.
#[derive(Debug, Clone, Copy)]
enum DrainExit {
    ResultEvent,
    SessionFinishedReconciler,
    ChannelClosed,
    Deadline,
}

impl std::fmt::Display for DrainExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            DrainExit::ResultEvent => "result_event",
            DrainExit::SessionFinishedReconciler => "session_finished_reconciler",
            DrainExit::ChannelClosed => "channel_closed",
            DrainExit::Deadline => "deadline",
        })
    }
}

/// Drain events until the naming turn completes.
///
/// Some providers (notably OpenCode for short turns) don't emit a terminal
/// `Result` event, so we mirror the stream_reader pattern: poll recv with a
/// short timeout and fall back to the provider's `session_finished` reconciler.
/// An overall deadline prevents the UI skeleton from hanging indefinitely
/// if everything misbehaves.
///
/// The reconciler probe also returns the latest assistant text so we can
/// recover when streaming text has not yet reached the channel before
/// the run finishes — without that recovery, short turns can race
/// past the 500 ms recv window with `accumulated_text` still empty, which
/// leaves the feature stuck on its default "Session N" title.
pub(super) async fn drain_text(
    feature_id: i64,
    provider_id: &str,
    mut session: Box<dyn AgentRuntimeSession>,
) -> Result<String, RuntimeError> {
    let runtime_session_id = session.session_id().await;
    debug!(
        feature_id,
        runtime_session_id = ?runtime_session_id,
        "auto-name: drain starting"
    );
    let mut rx = session.take_message_rx();
    let mut accumulated_text = String::new();
    let deadline = Instant::now() + AUTO_NAME_DEADLINE;
    let mut events_seen: u32 = 0;
    let exit_reason: DrainExit;

    loop {
        if Instant::now() >= deadline {
            warn!(feature_id, "auto-name: stream deadline exceeded, bailing");
            exit_reason = DrainExit::Deadline;
            break;
        }

        match tokio::time::timeout(AUTO_NAME_RECV_TIMEOUT, rx.recv()).await {
            Ok(Some(Ok(event))) => {
                events_seen += 1;
                if event.is_result() {
                    exit_reason = DrainExit::ResultEvent;
                    break;
                }

                if let Some(message) = event.assistant_message() {
                    for block in &message.content {
                        if let RuntimeContentBlock::Text { text } = block {
                            accumulated_text.push_str(text);
                        }
                    }
                }

                if let Some(stream_event) = event.stream_event() {
                    match stream_event {
                        RuntimeStreamEvent::ContentBlockStart {
                            block: RuntimeContentBlock::Text { text },
                            ..
                        } => accumulated_text.push_str(text),
                        RuntimeStreamEvent::ContentBlockDelta {
                            delta: RuntimeContentDelta::Text { text },
                            ..
                        } => accumulated_text.push_str(text),
                        _ => {}
                    }
                }

                if events_seen <= 5 {
                    debug!(
                        feature_id,
                        events_seen,
                        text_len = accumulated_text.len(),
                        raw = %truncate_for_log(event.raw_json().to_string().as_str(), 300),
                        "auto-name: event"
                    );
                }
            }
            Ok(Some(Err(e))) => {
                debug!(feature_id, error = %e, "auto-name: stream error");
            }
            Ok(None) => {
                exit_reason = DrainExit::ChannelClosed;
                break;
            }
            Err(_) => {
                // No event this tick — ask the provider whether the
                // session is done. The probe also returns the latest
                // assistant text so we can recover from the stream-vs-finish
                // race; the `is_empty()` guard keeps stream-delivered text
                // winning so partial stream + fallback can't duplicate.
                if let Some(sid) = runtime_session_id.as_deref() {
                    if let Some(final_text) = runtime_session_finished_text(provider_id, sid).await
                    {
                        if accumulated_text.is_empty() && !final_text.is_empty() {
                            debug!(
                                feature_id,
                                fallback_text_len = final_text.len(),
                                "auto-name: recovered final text via http probe"
                            );
                            accumulated_text = final_text;
                        }
                        exit_reason = DrainExit::SessionFinishedReconciler;
                        break;
                    }
                }
            }
        }
    }

    info!(
        feature_id,
        exit_reason = %exit_reason,
        events_seen,
        text_len = accumulated_text.len(),
        "auto-name: drain exiting"
    );

    // Close cooperatively — some adapters (OpenCode) leave server-side
    // session state behind otherwise.
    session.close().await?;
    Ok(accumulated_text)
}

/// Clamp a string to `max` bytes at a char boundary for log output. Prevents
/// an OpenCode message with a long payload from flooding the log line.
pub(super) fn truncate_for_log(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

pub(super) fn report_close_error(
    senders: &[tokio::sync::mpsc::UnboundedSender<axum::extract::ws::Message>],
    error: RuntimeError,
) {
    use crate::domain::ws_session::protocol::{SessionErrorPayload, WsEnvelope};

    let envelope = WsEnvelope::session_event(&WsSessionEvent::Error(SessionErrorPayload {
        code: "RUNTIME_CLOSE_FAILED".into(),
        message: error.to_string(),
        ..Default::default()
    }))
    .expect("runtime close error should serialize");
    super::send_to_all(senders, String::from(envelope));
}

#[cfg(test)]
mod tests {
    use super::DrainExit;

    #[test]
    fn drain_exit_display_matches_log_contract() {
        // These strings appear in operator log queries — keep them stable.
        assert_eq!(DrainExit::ResultEvent.to_string(), "result_event");
        assert_eq!(
            DrainExit::SessionFinishedReconciler.to_string(),
            "session_finished_reconciler"
        );
        assert_eq!(DrainExit::ChannelClosed.to_string(), "channel_closed");
        assert_eq!(DrainExit::Deadline.to_string(), "deadline");
    }
}
