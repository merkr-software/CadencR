//! `session.stream`: a read-only, bounded tap on a feature's agent traffic.
//!
//! The filter runs in the sender registry on the raw frame, before anything
//! is cloned; accepted frames queue on a bounded channel, and a plugin that
//! falls behind drops its backlog and resyncs. The agent stream never waits
//! on, or buffers for, a plugin.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::ws::Message;
use futures::FutureExt;
use tokio::sync::mpsc;

use super::emitter::{Emitter, Frame};
use super::subscriptions::{Cleanup, Started};
use crate::app_state::AppState;
use crate::domain::ws_session::sender_registry::FeatureObserver;

/// Frames a `session.stream` observer may queue before it lags; it then
/// drops its backlog and resyncs rather than holding the agent stream up.
const SESSION_STREAM_CAPACITY: usize = 256;

/// Session events a plugin may observe: transcript and turn progress. Control
/// replies (anything with a `ref`), drafts, configuration and runtime
/// internals are not forwarded.
const OBSERVABLE_SESSION_ACTIONS: [&str; 15] = [
    "message",
    "user_message",
    "usage_update",
    "ended",
    "error",
    "lifecycle",
    "stream_status",
    "history.added",
    "compact.started",
    "prompt_received",
    "permission.request",
    "gate.closed",
    "branch.rewound",
    "branch.forked",
    "cleared",
];

/// A bounded, filtered observer on the feature's traffic: frames a plugin may
/// not see are rejected before they are cloned, and the agent stream never
/// waits on the plugin.
pub fn start(state: &AppState, feature_id: i64, emitter: Emitter) -> Started {
    let (sender, mut rx) = mpsc::channel(SESSION_STREAM_CAPACITY);
    let lagged = Arc::new(AtomicBool::new(false));
    state.ws_feature_senders.observe(
        feature_id,
        FeatureObserver {
            sender: sender.clone(),
            accepts: is_observable_session_frame,
            lagged: lagged.clone(),
        },
    );
    let run = async move {
        while let Some(message) = rx.recv().await {
            let open = if lagged.swap(false, Ordering::AcqRel) {
                // The backlog predates the loss; the refetch covers it.
                while rx.try_recv().is_ok() {}
                emitter.resync()
            } else {
                forward(&message, &emitter, |_| true)
            };
            if !open {
                return;
            }
        }
    };
    Started {
        run: run.boxed(),
        cleanup: Cleanup::FeatureObserver(sender),
    }
}

/// Forward one registered-sender frame when `keep` accepts it; `false` once
/// the socket is gone. Its payload is never parsed into a tree.
pub fn forward(message: &Message, emitter: &Emitter, keep: impl Fn(&Frame<'_>) -> bool) -> bool {
    let Message::Text(text) = message else {
        return true;
    };
    match Frame::parse(text.as_str()) {
        Some(frame) if keep(&frame) => emitter.emit_frame(&frame),
        _ => true,
    }
}

/// The `session.stream` source filter, run on the raw frame before it is
/// cloned: only read-only transcript and turn-progress events, never replies.
fn is_observable_session_frame(text: &str) -> bool {
    Frame::parse(text).is_some_and(|frame| {
        frame.domain == "session"
            && frame.r#ref.is_none()
            && OBSERVABLE_SESSION_ACTIONS.contains(&&*frame.action)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::protocol::WsEnvelope;
    use serde_json::json;

    #[test]
    fn session_filter_drops_replies_and_private_actions() {
        let frame = |envelope: WsEnvelope| String::from(envelope);
        let event = |action: &str| frame(WsEnvelope::new("session", action, json!({})));
        assert!(is_observable_session_frame(&event("message")));
        assert!(!is_observable_session_frame(&event("draft.saved")));
        assert!(!is_observable_session_frame(&event("config.snapshot")));
        assert!(!is_observable_session_frame(&frame(WsEnvelope::reply(
            "r",
            "session",
            "message",
            json!({})
        ))));
        assert!(!is_observable_session_frame(&frame(WsEnvelope::new(
            "git",
            "message",
            json!({})
        ))));
        assert!(!is_observable_session_frame("not json"));
    }
}
