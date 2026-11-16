mod lines;
mod stderr_tail;

use lines::read_bounded_line;
pub(crate) use stderr_tail::StderrTail;

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tokio::io::{AsyncRead, BufReader};
use tokio::process::{Child, ChildStderr};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::error::SdkError;
use crate::event_queue::EventHub;
use crate::protocol::{decode_inbound_message, InboundMessage};
use crate::types::{AppServerEvent, AppServerExit};

pub(crate) type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, SdkError>>>;

pub(crate) struct ReaderState {
    pub(crate) pending: Arc<StdMutex<PendingMap>>,
    pub(crate) events: EventHub,
    pub(crate) max_line_bytes: usize,
}

pub(crate) fn spawn_reader<R>(state: ReaderState, stdout: R) -> JoinHandle<()>
where
    R: AsyncRead + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_bounded_line(&mut reader, state.max_line_bytes).await {
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                    Ok(message) => {
                        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                            handle_message(&state, message);
                        }));
                        if let Err(payload) = result {
                            tracing::error!(
                                "codex app-server reader panicked while handling message"
                            );
                            drain_pending_process_exited(&state.pending);
                            std::panic::resume_unwind(payload);
                        }
                    }
                    Err(error) => tracing::warn!(%error, "failed to parse codex app-server line"),
                },
                Ok(None) => {
                    report_transport_error(
                        &state,
                        SdkError::Protocol("app-server stdout closed".to_string()),
                    );
                    return;
                }
                Err(error) => {
                    tracing::warn!(%error, "codex app-server stdout read failed");
                    report_transport_error(&state, error);
                    return;
                }
            }
        }
    })
}

pub(crate) fn spawn_stderr_reader(
    stderr: ChildStderr,
    max_line_bytes: usize,
    tail: Arc<StdMutex<StderrTail>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        loop {
            match read_bounded_line(&mut reader, max_line_bytes).await {
                // Codex diagnostics can quote config values. Never log raw
                // stderr because profile TOML and env may contain credentials;
                // the tail is only handed to the client's owner.
                Ok(Some(line)) => {
                    if let Ok(mut tail) = tail.lock() {
                        tail.push(&line);
                    }
                    tracing::warn!(
                        target: "codex_app_server",
                        "codex app-server emitted a stderr diagnostic (content redacted)"
                    );
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(%error, "codex app-server stderr read failed");
                    break;
                }
            }
        }
    })
}

pub(crate) fn spawn_reaper(
    mut child: Child,
    mut kill_rx: oneshot::Receiver<()>,
    pending: Arc<StdMutex<PendingMap>>,
    events: EventHub,
    exit: Arc<StdMutex<Option<AppServerExit>>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        // Biased: a process that already died is reported as such even when
        // its owner, having seen stdout close, asks to stop it at once.
        let (status, stopped) = tokio::select! {
            biased;
            status = child.wait() => (status, false),
            _ = &mut kill_rx => match child.try_wait() {
                Ok(Some(status)) => (Ok(status), false),
                _ => {
                    let _ = child.start_kill();
                    (child.wait().await, true)
                }
            }
        };
        match status {
            Ok(status) => {
                let (code, signal) = (status.code(), exit_signal(&status));
                // A process killed on request reports no exit code; one that
                // still has a code was already exiting by itself.
                let on_its_own = !stopped || (cfg!(unix) && code.is_some());
                if on_its_own {
                    if let Ok(mut exit) = exit.lock() {
                        *exit = Some(AppServerExit { code, signal });
                    }
                }
                send_process_exited(&pending, &events, code, signal);
            }
            Err(error) => {
                tracing::warn!(%error, "failed to reap codex app-server process");
                send_process_exited(&pending, &events, None, None);
            }
        }
    })
}

fn handle_message(state: &ReaderState, message: Value) {
    match decode_inbound_message(message) {
        InboundMessage::Event(event) => {
            state.events.send(event);
        }
        InboundMessage::Response { id, result } => {
            let tx = state
                .pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&id));
            if let Some(tx) = tx {
                let _ = tx.send(result);
            }
        }
        InboundMessage::Ignore => {}
    }
}

fn send_process_exited(
    pending: &Arc<StdMutex<PendingMap>>,
    events: &EventHub,
    status: Option<i32>,
    signal: Option<i32>,
) {
    drain_pending_process_exited(pending);
    events.send(AppServerEvent::ProcessExited { status, signal });
}

fn drain_pending_process_exited(pending: &Arc<StdMutex<PendingMap>>) {
    drain_pending_with(pending, || SdkError::ProcessExited);
}

fn drain_pending_with(pending: &Arc<StdMutex<PendingMap>>, make_error: impl Fn() -> SdkError) {
    if let Ok(mut pending) = pending.lock() {
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(make_error()));
        }
    }
}

fn report_transport_error(state: &ReaderState, error: SdkError) {
    let message = match error {
        SdkError::Protocol(message) => {
            drain_pending_with(&state.pending, || SdkError::Protocol(message.clone()));
            message
        }
        SdkError::Io(error) => {
            let kind = error.kind();
            let detail = error.to_string();
            drain_pending_with(&state.pending, || {
                SdkError::Io(std::io::Error::new(kind, detail.clone()))
            });
            format!("io error: {detail}")
        }
        error => {
            let message = error.to_string();
            drain_pending_with(&state.pending, || SdkError::Protocol(message.clone()));
            message
        }
    };
    state
        .events
        .send(AppServerEvent::TransportError { message });
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex as StdMutex};

    use serde_json::{json, Value};
    use tokio::io::AsyncWriteExt;
    use tokio::sync::{broadcast, oneshot};

    use super::{
        drain_pending_process_exited, handle_message, spawn_reader, ReaderState, SdkError,
    };
    use crate::types::AppServerEvent;

    type PendingMap = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, SdkError>>>>>;

    fn reader_state() -> (ReaderState, broadcast::Receiver<AppServerEvent>, PendingMap) {
        let events = crate::event_queue::EventHub::new();
        let event_rx = events.subscribe();
        let pending = Arc::new(StdMutex::new(HashMap::new()));
        (
            ReaderState {
                pending: Arc::clone(&pending),
                events,
                max_line_bytes: 1024,
            },
            event_rx,
            pending,
        )
    }

    #[tokio::test]
    async fn oversized_frame_reports_transport_error_without_claiming_process_exit() {
        let (mut state, mut event_rx, pending) = reader_state();
        state.max_line_bytes = 3;
        let (tx, rx) = oneshot::channel();
        pending.lock().unwrap().insert(9, tx);
        let (reader, mut writer) = tokio::io::duplex(64);
        let reader_task = spawn_reader(state, reader);

        writer.write_all(b"abcdef\n").await.unwrap();
        drop(writer);

        let AppServerEvent::TransportError { message } = event_rx.recv().await.unwrap() else {
            panic!("expected transport error event");
        };
        assert_eq!(message, "app-server line exceeded 3 bytes");
        assert_eq!(
            rx.await.unwrap().unwrap_err().to_string(),
            "app-server protocol error: app-server line exceeded 3 bytes"
        );
        reader_task.await.unwrap();
    }

    #[tokio::test]
    async fn stdout_eof_reports_transport_error() {
        let (state, mut event_rx, pending) = reader_state();
        let (tx, rx) = oneshot::channel();
        pending.lock().unwrap().insert(9, tx);

        spawn_reader(state, tokio::io::empty()).await.unwrap();

        let AppServerEvent::TransportError { message } = event_rx.recv().await.unwrap() else {
            panic!("expected transport error event");
        };
        assert_eq!(message, "app-server stdout closed");
        assert_eq!(
            rx.await.unwrap().unwrap_err().to_string(),
            "app-server protocol error: app-server stdout closed"
        );
    }

    #[tokio::test]
    async fn handle_message_routes_responses_to_pending_request() {
        let (state, _event_rx, pending) = reader_state();
        let (tx, rx) = oneshot::channel();
        pending.lock().unwrap().insert(7, tx);

        handle_message(&state, json!({ "id": 7, "result": { "ok": true } }));

        assert_eq!(rx.await.unwrap().unwrap(), json!({ "ok": true }));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn handle_message_broadcasts_server_requests() {
        let (state, mut event_rx, _pending) = reader_state();

        handle_message(
            &state,
            json!({ "id": "approval", "method": "tool/request", "params": { "x": 1 } }),
        );

        let AppServerEvent::ServerRequest { id, method, params } = event_rx.recv().await.unwrap()
        else {
            panic!("expected server request event");
        };
        assert_eq!(id, json!("approval"));
        assert_eq!(method, "tool/request");
        assert_eq!(params, json!({ "x": 1 }));
    }

    #[tokio::test]
    async fn reader_delivers_rpc_response_while_runtime_is_stalled() {
        let (state, _observer, pending) = reader_state();
        let mut runtime = state.events.subscribe_reliable();
        let (response_tx, response_rx) = oneshot::channel();
        pending.lock().unwrap().insert(7, response_tx);
        let (reader, mut writer) = tokio::io::duplex(4096);
        let task = spawn_reader(state, reader);
        let writer_task = tokio::spawn(async move {
            for n in 0..2_000 {
                let frame =
                    json!({"method": "item/commandExecution/outputDelta", "params": {"n": n}});
                writer
                    .write_all(format!("{frame}\n").as_bytes())
                    .await
                    .unwrap();
            }
            writer
                .write_all(b"{\"id\":7,\"result\":{\"ok\":true}}\n")
                .await
                .unwrap();
            writer
                .write_all(b"{\"id\":42,\"method\":\"approval\",\"params\":{}}\n")
                .await
                .unwrap();
            writer
                .write_all(b"{\"method\":\"turn/completed\",\"params\":{}}\n")
                .await
                .unwrap();
        });
        // Simulates startup or descendant recovery: await the RPC without
        // draining any events, even with more than 512 frames ahead of it.
        let response = tokio::time::timeout(std::time::Duration::from_secs(5), response_rx)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(response, json!({"ok": true}));
        writer_task.await.unwrap();
        task.await.unwrap();
        for n in 0..2_000 {
            assert!(matches!(runtime.recv().await,
                Some(AppServerEvent::Notification { params, .. }) if params["n"] == n));
        }
        assert!(matches!(
            runtime.recv().await,
            Some(AppServerEvent::ServerRequest { .. })
        ));
        assert!(matches!(runtime.recv().await,
            Some(AppServerEvent::Notification { method, .. }) if method == "turn/completed"));
        assert!(matches!(
            runtime.recv().await,
            Some(AppServerEvent::TransportError { .. })
        ));
        assert!(runtime.recv().await.is_none());
    }

    #[tokio::test]
    async fn process_exit_drains_pending_requests() {
        let (_state, _event_rx, pending) = reader_state();
        let (tx, rx) = oneshot::channel();
        pending.lock().unwrap().insert(9, tx);

        drain_pending_process_exited(&pending);

        assert!(matches!(rx.await.unwrap(), Err(SdkError::ProcessExited)));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_reaper_records_an_exit_on_its_own_with_the_stderr_tail() {
        use std::process::Stdio;

        use super::{spawn_reaper, spawn_stderr_reader, StderrTail};
        use crate::event_queue::EventHub;
        use crate::types::AppServerExit;

        let mut child = tokio::process::Command::new("/bin/sh")
            .args([
                "-c",
                "echo booting >&2; echo 'config error: bad model' >&2; exit 3",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let tail = Arc::new(StdMutex::new(StderrTail::default()));
        let stderr = spawn_stderr_reader(child.stderr.take().unwrap(), 1024, Arc::clone(&tail));
        let exit = Arc::new(StdMutex::new(None));
        let (_kill_tx, kill_rx) = oneshot::channel();
        let reaper = spawn_reaper(
            child,
            kill_rx,
            Arc::new(StdMutex::new(HashMap::new())),
            EventHub::new(),
            Arc::clone(&exit),
        );
        reaper.await.unwrap();
        stderr.await.unwrap();

        assert_eq!(
            *exit.lock().unwrap(),
            Some(AppServerExit {
                code: Some(3),
                signal: None
            })
        );
        assert_eq!(
            tail.lock().unwrap().lines(),
            vec!["booting".to_string(), "config error: bad model".to_string()]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_process_that_died_before_the_stop_request_still_records_its_exit() {
        use std::process::Stdio;

        use super::spawn_reaper;
        use crate::event_queue::EventHub;
        use crate::types::AppServerExit;

        let child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "exit 4"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // Dead but not reaped yet, and asked to stop before the reaper runs:
        // the owner saw stdout close and shut the client down at once.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let exit = Arc::new(StdMutex::new(None));
        let (kill_tx, kill_rx) = oneshot::channel();
        kill_tx.send(()).unwrap();
        spawn_reaper(
            child,
            kill_rx,
            Arc::new(StdMutex::new(HashMap::new())),
            EventHub::new(),
            Arc::clone(&exit),
        )
        .await
        .unwrap();

        assert_eq!(
            *exit.lock().unwrap(),
            Some(AppServerExit {
                code: Some(4),
                signal: None
            })
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_process_stopped_by_its_client_records_no_exit() {
        use std::process::Stdio;

        use super::spawn_reaper;
        use crate::event_queue::EventHub;

        let child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let exit = Arc::new(StdMutex::new(None));
        let (kill_tx, kill_rx) = oneshot::channel();
        let reaper = spawn_reaper(
            child,
            kill_rx,
            Arc::new(StdMutex::new(HashMap::new())),
            EventHub::new(),
            Arc::clone(&exit),
        );
        kill_tx.send(()).unwrap();
        reaper.await.unwrap();

        assert_eq!(*exit.lock().unwrap(), None);
    }
}
