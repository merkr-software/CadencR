use std::time::Duration;

use axum::http::StatusCode;
use tokio::task::JoinHandle;
use tokio::time::{timeout, timeout_at, Instant};
use tracing::{info, warn};

use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeContentBlock, RuntimeContentDelta, RuntimeError, RuntimeEvent,
    RuntimeStreamEvent,
};
use crate::domain::agents::providers::runtime_session_finished_text;
use crate::error::AppError;

use super::{prompt::title_from_response, runtime_failure};

const AUTO_NAME_DEADLINE: Duration = Duration::from_secs(30);
const AUTO_NAME_CLOSE_DEADLINE: Duration = Duration::from_secs(15);

enum DrainExit {
    ResultEvent { failed: bool },
    ChannelClosed,
    StreamError(RuntimeError),
    Deadline,
}

impl DrainExit {
    fn reason(&self) -> &'static str {
        match self {
            Self::ResultEvent { .. } => "result_event",
            Self::ChannelClosed => "channel_closed",
            Self::StreamError(_) => "stream_error",
            Self::Deadline => "deadline",
        }
    }
}

struct RuntimeToClose {
    feature_id: i64,
    session: Option<Box<dyn AgentRuntimeSession>>,
}

impl RuntimeToClose {
    fn start_close(&mut self) -> Option<JoinHandle<Result<(), AppError>>> {
        let mut session = self.session.take()?;
        let feature_id = self.feature_id;
        Some(tokio::spawn(async move {
            session.close().await.map_err(|error| {
                let error = runtime_failure(
                    error,
                    "RUNTIME_CLOSE_FAILED",
                    "The auto-naming provider did not close cleanly. Try again.",
                );
                warn!(
                    feature_id,
                    code = error.code(),
                    "auto-name: runtime close failed"
                );
                error
            })
        }))
    }
}

impl Drop for RuntimeToClose {
    fn drop(&mut self) {
        // The request may be cancelled while its naming runtime is active.
        drop(self.start_close());
    }
}

pub(super) async fn drain_title(
    feature_id: i64,
    provider_id: &str,
    session: Box<dyn AgentRuntimeSession>,
) -> Result<String, AppError> {
    let mut runtime = RuntimeToClose {
        feature_id,
        session: Some(session),
    };
    let session = runtime.session.as_deref_mut().expect("runtime is open");
    let result = drain_text(feature_id, provider_id, session)
        .await
        .and_then(|text| title_from_response(&text));

    // Let the close task finish independently if its reply budget elapses.
    // The error that already prevented naming takes priority over cleanup.
    let close = runtime.start_close().expect("runtime is open");
    let close = wait_for_close(feature_id, close).await;
    let title = result?;
    close?;
    Ok(title)
}

async fn wait_for_close(
    feature_id: i64,
    close: JoinHandle<Result<(), AppError>>,
) -> Result<(), AppError> {
    let (status, message) = match timeout(AUTO_NAME_CLOSE_DEADLINE, close).await {
        Ok(Ok(result)) => return result,
        Ok(Err(_)) => (
            StatusCode::BAD_GATEWAY,
            "The auto-naming provider did not close cleanly. Try again.",
        ),
        Err(_) => (
            StatusCode::GATEWAY_TIMEOUT,
            "The auto-naming provider did not close in time. Try again.",
        ),
    };
    warn!(feature_id, %status, "auto-name: runtime close did not finish");
    Err(AppError::coded(status, "RUNTIME_CLOSE_FAILED", message))
}

async fn drain_text(
    feature_id: i64,
    provider_id: &str,
    session: &mut dyn AgentRuntimeSession,
) -> Result<String, AppError> {
    let mut rx = session.take_message_rx();
    let mut text = String::new();
    let mut provider_failed = false;
    let deadline = Instant::now() + AUTO_NAME_DEADLINE;

    let exit = loop {
        if Instant::now() >= deadline {
            break DrainExit::Deadline;
        }
        match timeout_at(deadline, rx.recv()).await {
            Ok(Some(Ok(event))) => {
                provider_failed |= event
                    .provider_error()
                    .is_some_and(|error| error.parent_tool_use_id.is_none());
                if event.is_result() {
                    break DrainExit::ResultEvent {
                        failed: event.result_error().is_some(),
                    };
                }
                append_text(&mut text, &event);
            }
            Ok(Some(Err(error))) => break DrainExit::StreamError(error),
            Ok(None) => break DrainExit::ChannelClosed,
            Err(_) => break DrainExit::Deadline,
        }
    };
    drop(rx);

    info!(
        feature_id,
        exit_reason = exit.reason(),
        text_len = text.len(),
        "auto-name: drain exiting"
    );

    if provider_failed || matches!(exit, DrainExit::ResultEvent { failed: true }) {
        // A provider can report its failure before an otherwise clean result
        // or transport closure. Keep that earlier cause for the naming turn.
        return Err(AppError::coded(
            StatusCode::BAD_GATEWAY,
            "AUTO_NAME_PROVIDER_FAILED",
            "The auto-naming provider failed while generating the title. Check its model and authentication, then try again.",
        ));
    }

    match exit {
        DrainExit::StreamError(error) => Err(runtime_failure(
            error,
            "AUTO_NAME_STREAM_FAILED",
            "The auto-naming provider's connection failed before the title was ready. Try again.",
        )),
        DrainExit::Deadline => Err(AppError::coded(
            StatusCode::GATEWAY_TIMEOUT,
            "AUTO_NAME_TIMEOUT",
            "The auto-naming provider did not finish in time. Try again or choose a faster naming model.",
        )),
        DrainExit::ChannelClosed => {
            let confirmed = timeout_at(deadline, async {
                let sid = session.session_id().await?;
                runtime_session_finished_text(provider_id, &sid).await
            }).await;
            match confirmed {
                Ok(Some(fallback)) => Ok(if text.is_empty() { fallback } else { text }),
                _ => Err(AppError::coded(
                    StatusCode::BAD_GATEWAY,
                    "AUTO_NAME_STREAM_CLOSED",
                    "The auto-naming provider closed the connection before confirming a title. Try again.",
                )),
            }
        }
        DrainExit::ResultEvent { .. } => Ok(text),
    }
}

fn append_text(text: &mut String, event: &RuntimeEvent) {
    if let Some(message) = event.assistant_message() {
        for block in &message.content {
            if let RuntimeContentBlock::Text { text: block_text } = block {
                text.push_str(block_text);
            }
        }
    }
    match event.stream_event() {
        Some(RuntimeStreamEvent::ContentBlockStart {
            block: RuntimeContentBlock::Text { text: delta },
            ..
        })
        | Some(RuntimeStreamEvent::ContentBlockDelta {
            delta: RuntimeContentDelta::Text { text: delta },
            ..
        }) => text.push_str(delta),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeEventKind, RuntimeEventMetadata, RuntimeMessageRx,
        RuntimePermissionMode, RuntimeResultError,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio::sync::mpsc;

    struct NamingSession {
        rx: Option<RuntimeMessageRx>,
        closed: Arc<AtomicBool>,
        fail_close: bool,
    }

    #[async_trait::async_trait]
    impl AgentRuntimeSession for NamingSession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            self.rx.take().unwrap()
        }

        async fn session_id(&self) -> Option<String> {
            None
        }

        async fn stream_input(&self, _: serde_json::Value) -> Result<(), RuntimeError> {
            unreachable!()
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            unreachable!()
        }

        async fn close(&mut self) -> Result<(), RuntimeError> {
            assert!(!self.closed.swap(true, Ordering::Relaxed));
            if self.fail_close {
                return Err(RuntimeError::new("close failed: synthetic-private-value"));
            }
            Ok(())
        }

        async fn set_model(&self, _: &str) -> Result<(), RuntimeError> {
            unreachable!()
        }

        async fn set_permission_mode(&self, _: RuntimePermissionMode) -> Result<(), RuntimeError> {
            unreachable!()
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

    async fn run_drain(rx: RuntimeMessageRx, fail_close: bool) -> Result<String, AppError> {
        let closed = Arc::new(AtomicBool::new(false));
        let session = NamingSession {
            rx: Some(rx),
            closed: closed.clone(),
            fail_close,
        };
        let result = drain_title(1, "naming-test", Box::new(session)).await;
        assert!(
            closed.load(Ordering::Relaxed),
            "drain must always close the runtime"
        );
        result
    }

    fn event(kind: RuntimeEventKind) -> RuntimeEvent {
        RuntimeEvent::new(RuntimeEventMetadata::default(), kind)
    }

    fn text_event(text: &str) -> RuntimeEvent {
        event(RuntimeEventKind::AssistantMessage {
            message: RuntimeAssistantMessage {
                model: None,
                content: vec![RuntimeContentBlock::Text { text: text.into() }],
            },
            parent_tool_use_id: None,
        })
    }

    fn provider_error_event() -> RuntimeEvent {
        event(RuntimeEventKind::ProviderError {
            message: "provider failed: synthetic-private-value".into(),
            code: None,
            parent_tool_use_id: None,
        })
    }

    fn runtime_rx(events: Vec<Result<RuntimeEvent, RuntimeError>>) -> RuntimeMessageRx {
        let (tx, rx) = mpsc::channel(events.len().max(1));
        for item in events {
            tx.try_send(item).unwrap();
        }
        rx
    }

    #[tokio::test]
    async fn completed_title_is_returned_after_close() {
        let rx = runtime_rx(vec![
            Ok(text_event("Fix Login")),
            Ok(event(RuntimeEventKind::Result)),
        ]);
        assert_eq!(run_drain(rx, false).await.unwrap(), "Fix Login");
    }

    #[tokio::test]
    async fn provider_error_outranks_partial_text_stream_failure_and_close_failure() {
        let rx = runtime_rx(vec![
            Ok(text_event("Unfinished Title")),
            Ok(provider_error_event()),
            Err(RuntimeError::new("stream ended: synthetic-private-value")),
        ]);
        let error = run_drain(rx, true).await.unwrap_err();
        assert_eq!(error.code(), "AUTO_NAME_PROVIDER_FAILED");
        assert!(!error.to_string().contains("synthetic-private-value"));
    }

    #[tokio::test]
    async fn a_bare_terminal_acknowledgement_does_not_erase_a_provider_failure() {
        let rx = runtime_rx(vec![
            Ok(provider_error_event()),
            Ok(text_event("Unconfirmed Title")),
            Ok(event(RuntimeEventKind::Result)),
        ]);
        assert_eq!(
            run_drain(rx, false).await.unwrap_err().code(),
            "AUTO_NAME_PROVIDER_FAILED"
        );
    }

    #[tokio::test]
    async fn a_failed_terminal_result_is_not_a_success_or_an_empty_response() {
        let terminal =
            event(RuntimeEventKind::Result).with_result_error(Some(RuntimeResultError {
                code: "PROVIDER_FAILURE".into(),
                message: "result failed: synthetic-private-value".into(),
            }));
        let error = run_drain(runtime_rx(vec![Ok(terminal)]), false)
            .await
            .unwrap_err();
        assert_eq!(error.code(), "AUTO_NAME_PROVIDER_FAILED");
        assert!(!error.to_string().contains("synthetic-private-value"));
    }

    #[tokio::test]
    async fn stream_and_empty_response_failures_outrank_close_failure() {
        let stream = runtime_rx(vec![
            Ok(text_event("Partial")),
            Err(RuntimeError::new("stream failed")),
        ]);
        let empty = runtime_rx(vec![Ok(event(RuntimeEventKind::Result))]);
        for (rx, code) in [
            (stream, "AUTO_NAME_STREAM_FAILED"),
            (empty, "AUTO_NAME_EMPTY_RESPONSE"),
        ] {
            assert_eq!(run_drain(rx, true).await.unwrap_err().code(), code);
        }
    }

    #[tokio::test]
    async fn an_eof_without_a_result_does_not_confirm_partial_text() {
        let rx = runtime_rx(vec![Ok(text_event("__FEATURE_NAME_START__Fix"))]);
        let error = run_drain(rx, false).await.unwrap_err();
        assert_eq!(error.code(), "AUTO_NAME_STREAM_CLOSED");
    }

    #[tokio::test]
    async fn close_failure_is_returned_when_a_title_was_received() {
        let rx = runtime_rx(vec![
            Ok(text_event("Fix Login")),
            Ok(event(RuntimeEventKind::Result)),
        ]);
        let error = run_drain(rx, true).await.unwrap_err();
        assert_eq!(error.code(), "RUNTIME_CLOSE_FAILED");
        assert!(!error.to_string().contains("synthetic-private-value"));
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_rejects_partial_text_and_still_closes_the_runtime() {
        let (tx, rx) = mpsc::channel(1);
        tx.try_send(Ok(text_event("Unfinished Title"))).unwrap();
        let error = run_drain(rx, false).await.unwrap_err();
        assert_eq!(error.code(), "AUTO_NAME_TIMEOUT");
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_close_does_not_block_the_reply() {
        let close = tokio::spawn(async {
            tokio::time::sleep(AUTO_NAME_CLOSE_DEADLINE * 2).await;
            Ok(())
        });
        let error = wait_for_close(1, close).await.unwrap_err();
        assert_eq!(error.code(), "RUNTIME_CLOSE_FAILED");
        assert!(matches!(
            error,
            AppError::Coded {
                status: StatusCode::GATEWAY_TIMEOUT,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn cancelling_during_the_drain_still_closes_the_runtime() {
        let (_tx, rx) = mpsc::channel(1);
        let closed = Arc::new(AtomicBool::new(false));
        let session = NamingSession {
            rx: Some(rx),
            closed: closed.clone(),
            fail_close: false,
        };
        let mut drain = Box::pin(drain_title(1, "naming-test", Box::new(session)));
        assert!(futures::poll!(drain.as_mut()).is_pending());
        drop(drain);

        timeout(Duration::from_secs(1), async {
            while !closed.load(Ordering::Relaxed) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
