//! A Stop that Claude Code ignores ends the process, visibly.
//!
//! Same contract as ACP's cancel escalation: when the CLI does not acknowledge
//! the interrupt, or the turn it was running never ends, the reason is queued
//! on the runtime stream as [`RuntimeError::stop_escalated`] and the process
//! is killed. The stream reader then ends the turn as stopped and shows
//! `AGENT_STOP_ESCALATED`, and the next prompt spawns a fresh process that
//! resumes the conversation. Every interrupt gets this, a sleep's included:
//! that one only waits [`SLEEP_TIMEOUTS`], since the machine will not.

use std::time::{Duration, Instant};

use claude_agent_sdk_rs::InterruptTimeouts;
use tokio::sync::mpsc::WeakSender;

use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent};

pub(super) type RuntimeEventSender = WeakSender<Result<RuntimeEvent, RuntimeError>>;

/// A stop before an OS sleep. A responsive CLI acknowledges at once and ends
/// its turn within a second; one that does not is killed, its conversation
/// resumable on wake, instead of holding the pause for the full Stop wait.
pub(super) const SLEEP_TIMEOUTS: InterruptTimeouts = InterruptTimeouts {
    ack: Duration::from_secs(2),
    turn_complete: Duration::from_secs(3),
};

/// Interrupt `query` within `timeouts`; kill it when it ignores the stop. The
/// stop happened either way, so only a refused interrupt is an error.
pub(super) async fn interrupt_or_terminate(
    query: &claude_agent_sdk_rs::Query,
    timeouts: InterruptTimeouts,
    events: Option<&RuntimeEventSender>,
) -> Result<(), RuntimeError> {
    let started = Instant::now();
    match query.interrupt_within(timeouts).await {
        Err(claude_agent_sdk_rs::SdkError::Timeout) => {
            terminate_ignored_stop(query, started.elapsed(), events).await;
            Ok(())
        }
        result => result.map_err(RuntimeError::from),
    }
}

async fn terminate_ignored_stop(
    query: &claude_agent_sdk_rs::Query,
    waited: Duration,
    events: Option<&RuntimeEventSender>,
) {
    let message = format!(
        "Claude Code did not stop within {}s; its process was terminated.",
        waited.as_secs().max(1)
    );
    tracing::warn!("{message}");
    // Holding a sender keeps the stream open, so the reason still reaches the
    // reader ahead of the stream's end. It is sent from its own task: the
    // caller holds the runtime's locks, which a reader waiting for channel
    // room may need.
    let events = events.and_then(WeakSender::upgrade);
    query.kill().await;
    if let Some(events) = events {
        tokio::spawn(async move {
            if events
                .send(Err(RuntimeError::stop_escalated(message)))
                .await
                .is_err()
            {
                tracing::debug!("Claude runtime stream closed before the stop escalation");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tokio::sync::mpsc;
    use tokio::time::timeout;

    use super::*;

    /// A CLI that completes the handshake, then never answers again.
    async fn unresponsive_cli(dir: &std::path::Path) -> claude_agent_sdk_rs::Query {
        let script = r#"#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    v = json.loads(line)
    if v["type"] == "control_request" and v["request"]["subtype"] in ("initialize", "mcp_status"):
        print(json.dumps({"type":"control_response","response":{"subtype":"success","request_id":v["request_id"],"response":{"mcpServers":[]}}}), flush=True)
"#;
        let path = dir.join("claude");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        claude_agent_sdk_rs::query(
            serde_json::json!("work"),
            claude_agent_sdk_rs::Options {
                path_to_cli: Some(path),
                cwd: dir.to_path_buf(),
                ..Default::default()
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn an_ignored_stop_kills_the_process_and_reports_why() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut query = unresponsive_cli(dir.path()).await;
        let mut cli_output = query.take_message_rx();
        let (tx, mut rx) = mpsc::channel(4);

        terminate_ignored_stop(&query, Duration::from_secs(25), Some(&tx.downgrade())).await;

        let escalation = timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(escalation.is_stop_escalation(), "{escalation:?}");
        assert!(escalation.to_string().contains("did not stop within 25s"));
        let ended = timeout(Duration::from_secs(5), async {
            while cli_output.recv().await.is_some() {}
        })
        .await;
        assert!(ended.is_ok(), "the ignored CLI must be killed");
    }

    /// Found live: a suspend on a frozen CLI waited out the whole 15 s
    /// acknowledgement wait. A stop before sleep gives up within its bound,
    /// kills the CLI, and says how long it actually waited.
    #[tokio::test]
    async fn a_stop_before_sleep_kills_an_unresponsive_cli_within_its_bound() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut query = unresponsive_cli(dir.path()).await;
        let mut cli_output = query.take_message_rx();
        let (tx, mut rx) = mpsc::channel(4);
        let bound = InterruptTimeouts {
            ack: Duration::from_millis(300),
            turn_complete: Duration::from_secs(30),
        };

        let started = Instant::now();
        interrupt_or_terminate(&query, bound, Some(&tx.downgrade()))
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));

        let escalation = timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(escalation.is_stop_escalation(), "{escalation:?}");
        assert!(escalation.to_string().contains("did not stop within 1s"));
        let ended = timeout(Duration::from_secs(5), async {
            while cli_output.recv().await.is_some() {}
        })
        .await;
        assert!(ended.is_ok(), "the ignored CLI must be killed");
    }

    #[test]
    fn a_stop_before_sleep_is_bounded_well_under_the_stop_wait() {
        assert!(SLEEP_TIMEOUTS.total() <= Duration::from_secs(5));
        assert!(SLEEP_TIMEOUTS.total() < InterruptTimeouts::default().total());
    }

    #[tokio::test]
    async fn an_ignored_stop_still_kills_when_nobody_reads_the_stream() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut query = unresponsive_cli(dir.path()).await;
        let mut cli_output = query.take_message_rx();

        terminate_ignored_stop(&query, Duration::from_secs(25), None).await;

        let ended = timeout(Duration::from_secs(5), async {
            while cli_output.recv().await.is_some() {}
        })
        .await;
        assert!(ended.is_ok(), "the ignored CLI must be killed");
    }
}
