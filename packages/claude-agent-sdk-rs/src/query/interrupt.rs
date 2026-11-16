//! Interrupt handling for [`Query`](super::query_struct::Query).

use tokio::time::{sleep, timeout, Duration};

use crate::error::SdkError;

use super::query_struct::Query;
use super::turn_state::TurnState;

const INTERRUPT_TURN_COMPLETE_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// How long [`Query::interrupt_within`] waits at each step of a stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InterruptTimeouts {
    /// For the CLI to acknowledge the interrupt. Claude Code answers an
    /// interrupt as soon as it reads it, so a missing acknowledgement means
    /// its input loop is stuck, not that it is busy.
    pub ack: Duration,
    /// Once acknowledged, for the interrupted turn to report its end.
    pub turn_complete: Duration,
}

impl InterruptTimeouts {
    /// The longest the stop can wait before reporting [`SdkError::Timeout`].
    pub fn total(self) -> Duration {
        self.ack + self.turn_complete
    }
}

impl Default for InterruptTimeouts {
    fn default() -> Self {
        Self {
            ack: Duration::from_secs(15),
            turn_complete: Duration::from_secs(10),
        }
    }
}

impl Query {
    /// Interrupt the agent and wait until the CLI reports the interrupted turn
    /// as complete, within the [default](InterruptTimeouts::default) timeouts.
    /// This keeps a replayed steering prompt from being written while Claude
    /// Code is still winding down the old turn.
    ///
    /// [`SdkError::Timeout`] means the CLI ignored the stop: it did not
    /// acknowledge it, or the turn it was running never ended. The caller
    /// decides whether to [`kill`](Query::kill) it.
    pub async fn interrupt(&self) -> Result<(), SdkError> {
        self.interrupt_within(InterruptTimeouts::default()).await
    }

    /// [`interrupt`](Query::interrupt) with caller-chosen timeouts.
    pub async fn interrupt_within(&self, timeouts: InterruptTimeouts) -> Result<(), SdkError> {
        // SIGINT terminates recent stream-json CLIs. The protocol interrupt
        // cancels only the turn and leaves stdin available for follow-ups.
        self.send_control_request_with_timeout(
            serde_json::json!({ "subtype": "interrupt" }),
            timeouts.ack,
        )
        .await?;
        self.wait_for_interrupted_turn_complete(timeouts.turn_complete)
            .await
    }

    /// The longest [`interrupt`](Query::interrupt) waits before reporting
    /// [`SdkError::Timeout`].
    pub fn interrupt_timeout() -> Duration {
        InterruptTimeouts::default().total()
    }

    async fn wait_for_interrupted_turn_complete(&self, limit: Duration) -> Result<(), SdkError> {
        timeout(limit, async {
            loop {
                if matches!(self.turn_state().await, TurnState::TurnComplete { .. }) {
                    return;
                }
                sleep(INTERRUPT_TURN_COMPLETE_POLL_INTERVAL).await;
            }
        })
        .await
        .map_err(|_| SdkError::Timeout)
    }
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::time::{timeout, Duration};

    use crate::{query, InterruptTimeouts, Options, SdkError, SdkMessage, TurnState};

    use super::super::test_support::{mock_mcp_servers, write_mock_cli};

    async fn protocol_interrupt(result_before_ack: bool, reject: bool) {
        let dir = TempDir::new().unwrap();
        let script = format!(
            r#"#!/usr/bin/env python3
import json, signal, sys, time
signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
def send(v): print(json.dumps(v), flush=True)
def ack(v, reject=False):
    send({{"type":"control_response","response":{{"subtype":"error" if reject else "success","request_id":v["request_id"],"error":"interrupt refused","response":{{"mcpServers":[]}}}}}})
def result(text):
    send({{"type":"result","subtype":"success","uuid":"r","session_id":"s","duration_ms":1,"duration_api_ms":1,"is_error":False,"num_turns":1,"result":text,"total_cost_usd":0,"usage":{{"input_tokens":1,"output_tokens":1}}}})
ack(json.loads(sys.stdin.readline()))
ack(json.loads(sys.stdin.readline()))
sys.stdin.readline()
send({{"type":"system","subtype":"init","uuid":"u","session_id":"s","claude_code_version":"test","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"test","permission_mode":"default","slash_commands":[]}})
v=json.loads(sys.stdin.readline())
assert v["type"] == "control_request" and v["request"]["subtype"] == "interrupt", v
if {reject}:
    ack(v, True)
else:
    if {before}: result("interrupted")
    ack(v)
    if not {before}:
        time.sleep(0.05)
        result("interrupted")
    for line in sys.stdin:
        v=json.loads(line)
        assert v["type"] == "user", v
        result(v["message"]["content"])
"#,
            reject = if reject { "True" } else { "False" },
            before = if result_before_ack { "True" } else { "False" },
        );
        let mut q = query(
            json!("initial"),
            Options {
                path_to_cli: Some(write_mock_cli(dir.path(), &script)),
                mcp_servers: Some(mock_mcp_servers()),
                ..Options::default()
            },
        )
        .await
        .unwrap();
        q.next().await.unwrap().unwrap();
        let outcome = timeout(Duration::from_secs(3), q.interrupt()).await;
        if reject {
            assert!(
                matches!(outcome.unwrap(), Err(SdkError::ControlRequestFailed { subtype, .. }) if subtype == "interrupt")
            );
        } else {
            outcome
                .expect("interrupt must complete without killing the CLI")
                .unwrap();
            assert!(matches!(
                q.turn_state().await,
                TurnState::TurnComplete { .. }
            ));
            assert!(matches!(
                q.next().await.unwrap().unwrap(),
                SdkMessage::Result { .. }
            ));
            for text in ["immediate user prompt", "inter-agent reply"] {
                q.stream_input(json!(text)).await.unwrap();
                let event = timeout(Duration::from_secs(3), q.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert!(
                    matches!(event, SdkMessage::Result { result: Some(result), .. } if result == text)
                );
            }
        }
        q.close().await;
    }

    #[tokio::test]
    async fn protocol_interrupt_preserves_runtime_and_followup_delivery() {
        protocol_interrupt(false, false).await;
    }

    #[tokio::test]
    async fn protocol_interrupt_accepts_result_before_ack() {
        protocol_interrupt(true, false).await;
    }

    #[tokio::test]
    async fn protocol_interrupt_surfaces_rejection() {
        protocol_interrupt(false, true).await;
    }

    /// A background sub-agent asks for a permission after the turn that
    /// launched it returned its `result`. Claude Code (2.1.312, verified live)
    /// acknowledges a later interrupt, stops the background agents, and sends
    /// no `result`: no turn was running. Answering that permission must not
    /// make the SDK wait for one (it used to time out after 10 s, and Stop
    /// failed).
    async fn interrupt_after_late_permission(result_before_answer: bool) {
        use std::sync::Arc;

        use crate::permissions::{CanUseTool, PermissionRequest, PermissionResult};

        struct SlowDeny;

        #[async_trait::async_trait]
        impl CanUseTool for SlowDeny {
            async fn can_use_tool(&self, request: PermissionRequest) -> PermissionResult {
                tokio::time::sleep(Duration::from_millis(150)).await;
                PermissionResult::Deny {
                    message: "denied".into(),
                    interrupt: None,
                    tool_use_id: Some(request.tool_use_id),
                }
            }
        }

        let dir = TempDir::new().unwrap();
        let script = format!(
            r#"#!/usr/bin/env python3
import json, sys
def send(v): print(json.dumps(v), flush=True)
def ack(v): send({{"type":"control_response","response":{{"subtype":"success","request_id":v["request_id"],"response":{{"mcpServers":[]}}}}}})
def result():
    send({{"type":"result","subtype":"success","uuid":"r","session_id":"s","duration_ms":1,"duration_api_ms":1,"is_error":False,"num_turns":1,"result":"launched","total_cost_usd":0,"usage":{{"input_tokens":1,"output_tokens":1}}}})
ack(json.loads(sys.stdin.readline()))
ack(json.loads(sys.stdin.readline()))
sys.stdin.readline()
send({{"type":"system","subtype":"init","uuid":"u","session_id":"s","claude_code_version":"test","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"test","permission_mode":"plan","slash_commands":[]}})
if not {before}: result()
send({{"type":"control_request","request_id":"perm_1","request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{{"command":"ls"}},"agent_id":"bg"}}}})
if {before}: result()
v=json.loads(sys.stdin.readline())
assert v["type"] == "control_response" and v["response"]["request_id"] == "perm_1", v
send({{"type":"system","subtype":"task_progress","task_id":"bg","session_id":"s","uuid":"p"}})
v=json.loads(sys.stdin.readline())
assert v["type"] == "control_request" and v["request"]["subtype"] == "interrupt", v
ack(v)
sys.stdin.readline()
"#,
            before = if result_before_answer {
                "True"
            } else {
                "False"
            },
        );
        let mut q = query(
            json!("launch a background agent"),
            Options {
                path_to_cli: Some(write_mock_cli(dir.path(), &script)),
                mcp_servers: Some(mock_mcp_servers()),
                can_use_tool: Some(Arc::new(SlowDeny)),
                ..Options::default()
            },
        )
        .await
        .unwrap();
        // Read up to the marker the mock sends once it has the permission
        // answer: by then the result is in and the permission is resolved.
        loop {
            let message = timeout(Duration::from_secs(3), q.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            if serde_json::to_value(&message).unwrap()["subtype"] == "task_progress" {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(matches!(
            q.turn_state().await,
            TurnState::TurnComplete { .. }
        ));

        timeout(Duration::from_secs(3), q.interrupt())
            .await
            .expect("an interrupt with no running turn must not wait for a result")
            .unwrap();
        q.close().await;
    }

    /// A CLI that completes the handshake and reads the prompt, then either
    /// never answers again or acknowledges an interrupt without ending the
    /// turn.
    async fn stuck_cli(dir: &std::path::Path, acks_interrupt: bool) -> crate::Query {
        let script = format!(
            r#"#!/usr/bin/env python3
import json, sys
def ack(v): print(json.dumps({{"type":"control_response","response":{{"subtype":"success","request_id":v["request_id"],"response":{{"mcpServers":[]}}}}}}), flush=True)
for line in sys.stdin:
    v = json.loads(line)
    if v["type"] != "control_request":
        continue
    if v["request"]["subtype"] in ("initialize", "mcp_status") or {acks}:
        ack(v)
"#,
            acks = if acks_interrupt { "True" } else { "False" },
        );
        query(
            json!("work"),
            Options {
                path_to_cli: Some(write_mock_cli(dir, &script)),
                mcp_servers: Some(mock_mcp_servers()),
                ..Options::default()
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn interrupt_within_bounds_a_stop_the_cli_never_acknowledges() {
        let dir = TempDir::new().unwrap();
        let mut q = stuck_cli(dir.path(), false).await;
        let limits = InterruptTimeouts {
            ack: Duration::from_millis(200),
            turn_complete: Duration::from_secs(30),
        };

        let started = std::time::Instant::now();
        let outcome = q.interrupt_within(limits).await;

        assert!(matches!(outcome, Err(SdkError::Timeout)), "{outcome:?}");
        assert!(started.elapsed() < Duration::from_secs(2));
        q.close().await;
    }

    #[tokio::test]
    async fn interrupt_within_bounds_a_turn_that_never_ends() {
        let dir = TempDir::new().unwrap();
        let mut q = stuck_cli(dir.path(), true).await;
        let limits = InterruptTimeouts {
            ack: Duration::from_secs(30),
            turn_complete: Duration::from_millis(200),
        };

        let started = std::time::Instant::now();
        let outcome = q.interrupt_within(limits).await;

        assert!(matches!(outcome, Err(SdkError::Timeout)), "{outcome:?}");
        assert!(started.elapsed() < Duration::from_secs(2));
        q.close().await;
    }

    #[test]
    fn default_timeouts_keep_the_stop_contract() {
        let limits = InterruptTimeouts::default();
        assert_eq!(limits.total(), Duration::from_secs(25));
        assert_eq!(crate::Query::interrupt_timeout(), limits.total());
    }

    #[tokio::test]
    async fn interrupt_after_a_background_agent_permission_does_not_wait() {
        interrupt_after_late_permission(false).await;
    }

    #[tokio::test]
    async fn interrupt_after_a_permission_outlived_its_turn_does_not_wait() {
        interrupt_after_late_permission(true).await;
    }
}
