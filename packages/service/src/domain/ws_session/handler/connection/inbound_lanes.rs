//! The two lanes one connection runs its inbound commands on.
//!
//! Commands run one at a time, in arrival order. A long one — a
//! `session.compact` or `session.prompt.send` that first spawns its runtime —
//! must not hold up a control sent after it on the same socket: a Stop read
//! only once the runtime is up lets a Codex compaction start and run to its
//! end. So controls (stop, suspend/resume, permission and gate answers) run on
//! a lane of their own, in their arrival order, and the order between the two
//! lanes holds both ways:
//!
//! - a command runs once every control received before it was handled, so a
//!   prompt sent after a Stop reaches the runtime only after that Stop;
//! - a control runs once every command received before it ended, or reached
//!   the point where the control acts on it and called
//!   [`let_controls_through`]: a Stop sent after a prompt stops the turn that
//!   prompt starts, without waiting for its runtime to launch.

use std::future::Future;
use std::sync::Arc;

use tokio::sync::{mpsc, watch, Notify};
use tokio::task::JoinHandle;
use tracing::error;

use crate::domain::ws_session::protocol::{
    canonical_session_command_action, WsEnvelope, WsSessionCommandAction as Command,
};

/// Commands queued on a lane before reading the socket waits for room again.
const LANE_CAPACITY: usize = 64;

tokio::task_local! {
    /// The command the ordered lane is running, so it can let controls through.
    static RUNNING_COMMAND: RunningCommand;
}

/// Let the controls received after the running command run now. Called where a
/// Stop acts on the command (the session reads as working, its runtime launch
/// is claimed) and what is left of it may take long: a worktree setup, a
/// runtime spawn.
pub(crate) fn let_controls_through() {
    // Off a socket's ordered lane (HTTP, MCP, schedules), no control waits.
    let _ = RUNNING_COMMAND.try_with(RunningCommand::settle);
}

#[derive(Clone)]
struct RunningCommand {
    /// Position of the command among the connection's ordered commands.
    position: u64,
    /// Ordered commands controls no longer wait for: ended or let through.
    settled: Arc<watch::Sender<u64>>,
}

impl RunningCommand {
    fn settle(&self) {
        self.settled.send_if_modified(|settled| {
            let advanced = *settled < self.position;
            *settled = (*settled).max(self.position);
            advanced
        });
    }
}

/// A lane's worker ended (a handler panicked): the connection can no longer
/// run commands and closes.
#[derive(Debug)]
pub(super) struct LaneClosed;

struct OrderedCommand {
    envelope: WsEnvelope,
    position: u64,
    /// Controls received before this command, all handled before it runs.
    controls_before: u64,
}

struct ControlCommand {
    envelope: WsEnvelope,
    /// Ordered commands received before this control, settled before it runs.
    commands_before: u64,
}

/// Signals a lane's end, panics included (its worker drops the guard).
struct LaneEndGuard(Arc<Notify>);

impl Drop for LaneEndGuard {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

pub(super) struct InboundLanes {
    ordered: Option<mpsc::Sender<OrderedCommand>>,
    control: Option<mpsc::Sender<ControlCommand>>,
    controls_received: u64,
    commands_received: u64,
    ended: Arc<Notify>,
    workers: Vec<JoinHandle<()>>,
}

impl InboundLanes {
    /// Start both lanes; each runs `dispatch` on its commands.
    pub(super) fn spawn<D, F>(dispatch: D) -> Self
    where
        D: Fn(WsEnvelope) -> F + Send + Sync + 'static,
        F: Future<Output = ()> + Send + 'static,
    {
        let dispatch = Arc::new(dispatch);
        let ended = Arc::new(Notify::new());
        let (control_tx, mut control_rx) = mpsc::channel::<ControlCommand>(LANE_CAPACITY);
        let (ordered_tx, mut ordered_rx) = mpsc::channel::<OrderedCommand>(LANE_CAPACITY);
        let (handled_tx, mut handled_rx) = watch::channel(0u64);
        let (settled_tx, mut settled_rx) = watch::channel(0u64);
        let settled_tx = Arc::new(settled_tx);
        let control_dispatch = Arc::clone(&dispatch);
        let control_end = LaneEndGuard(Arc::clone(&ended));
        let control = tokio::spawn(async move {
            let _end = control_end;
            while let Some(control) = control_rx.recv().await {
                // Errs only once the ordered lane ended: nothing is left to wait for.
                let _ = settled_rx
                    .wait_for(|settled| *settled >= control.commands_before)
                    .await;
                control_dispatch(control.envelope).await;
                handled_tx.send_modify(|handled| *handled += 1);
            }
        });
        let ordered_end = LaneEndGuard(Arc::clone(&ended));
        let ordered = tokio::spawn(async move {
            let _end = ordered_end;
            while let Some(command) = ordered_rx.recv().await {
                // Errs only once the control lane ended: nothing is left to wait for.
                let _ = handled_rx
                    .wait_for(|handled| *handled >= command.controls_before)
                    .await;
                let running = RunningCommand {
                    position: command.position,
                    settled: Arc::clone(&settled_tx),
                };
                RUNNING_COMMAND
                    .scope(running.clone(), dispatch(command.envelope))
                    .await;
                running.settle();
            }
        });
        Self {
            ordered: Some(ordered_tx),
            control: Some(control_tx),
            controls_received: 0,
            commands_received: 0,
            ended,
            workers: vec![control, ordered],
        }
    }

    /// Fires when a lane's worker ends before [`Self::finish`]: a handler
    /// panicked, and the connection closes rather than drop later commands.
    pub(super) fn ended(&self) -> Arc<Notify> {
        Arc::clone(&self.ended)
    }

    /// Queue `envelope` on its lane. Waits only when that lane is full.
    pub(super) async fn route(&mut self, envelope: WsEnvelope) -> Result<(), LaneClosed> {
        if is_control(&envelope) {
            let lane = self.control.as_ref().ok_or(LaneClosed)?;
            let control = ControlCommand {
                envelope,
                commands_before: self.commands_received,
            };
            lane.send(control).await.map_err(|_| LaneClosed)?;
            self.controls_received += 1;
        } else {
            let lane = self.ordered.as_ref().ok_or(LaneClosed)?;
            let command = OrderedCommand {
                envelope,
                position: self.commands_received + 1,
                controls_before: self.controls_received,
            };
            lane.send(command).await.map_err(|_| LaneClosed)?;
            self.commands_received += 1;
        }
        Ok(())
    }

    /// Let both lanes run what was already received, as a connection that
    /// handled its commands inline did before reading the close.
    pub(super) async fn finish(mut self) {
        self.ordered = None;
        self.control = None;
        for worker in std::mem::take(&mut self.workers) {
            if let Err(join_error) = worker.await {
                error!(%join_error, "WebSocket command lane ended abnormally");
            }
        }
    }
}

impl Drop for InboundLanes {
    /// A connection cancelled mid-command (remote device revoked) drops what
    /// it was running, as it did when commands ran inline.
    fn drop(&mut self) {
        for worker in &self.workers {
            worker.abort();
        }
    }
}

fn is_control(envelope: &WsEnvelope) -> bool {
    envelope.domain == "session"
        && matches!(
            canonical_session_command_action(&envelope.action),
            Some(
                Command::Interrupt
                    | Command::Suspend
                    | Command::Resume
                    | Command::PermissionRespond
                    | Command::GateClose
            )
        )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::sync::{oneshot, Mutex};

    use super::*;

    fn envelope(action: &str, tag: &str) -> WsEnvelope {
        WsEnvelope {
            id: tag.to_string(),
            domain: "session".to_string(),
            action: action.to_string(),
            r#ref: None,
            payload: serde_json::Value::Null,
        }
    }

    /// Lanes whose dispatch records each command's id, and holds the command
    /// tagged `blocked` (or `yielding`, which first lets controls through)
    /// until the returned sender fires. `panics` panics.
    fn recording_lanes() -> (InboundLanes, Arc<Mutex<Vec<String>>>, oneshot::Sender<()>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let (release_tx, release_rx) = oneshot::channel::<()>();
        let release = Arc::new(Mutex::new(Some(release_rx)));
        let recorded = Arc::clone(&log);
        let lanes = InboundLanes::spawn(move |envelope: WsEnvelope| {
            let log = Arc::clone(&recorded);
            let release = Arc::clone(&release);
            async move {
                assert_ne!(envelope.id, "panics", "a handler panicked");
                if envelope.id == "yielding" {
                    let_controls_through();
                }
                if envelope.id == "blocked" || envelope.id == "yielding" {
                    let gate = release.lock().await.take().expect("one blocked command");
                    gate.await.expect("the test releases the blocked command");
                }
                log.lock().await.push(envelope.id);
            }
        });
        (lanes, log, release_tx)
    }

    async fn stays_unrun(log: &Mutex<Vec<String>>, len: usize) {
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(log.lock().await.len(), len, "the command still waits");
    }

    async fn wait_for_log(log: &Mutex<Vec<String>>, len: usize) -> Vec<String> {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let entries = log.lock().await.clone();
                if entries.len() >= len {
                    return entries;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the lanes ran the commands")
    }

    #[test]
    fn controls_are_the_commands_that_steer_running_work() {
        for action in [
            "interrupt",
            "suspend",
            "resume",
            "permission.respond",
            "gate.close",
        ] {
            assert!(is_control(&envelope(action, "c")), "{action}");
        }
        for action in ["init", "prompt.send", "compact", "destroy", "model.set"] {
            assert!(!is_control(&envelope(action, "c")), "{action}");
        }
        let mut app = envelope("interrupt", "c");
        app.domain = "app".to_string();
        assert!(!is_control(&app));
    }

    /// The live defect: a Stop sent right after `session.compact` waited for
    /// the compaction's runtime spawn, so Codex compacted to the end.
    #[tokio::test]
    async fn a_stop_runs_once_the_earlier_command_lets_controls_through() {
        let (mut lanes, log, release) = recording_lanes();
        lanes.route(envelope("compact", "yielding")).await.unwrap();
        lanes.route(envelope("interrupt", "stop")).await.unwrap();

        assert_eq!(wait_for_log(&log, 1).await, vec!["stop"]);

        release.send(()).unwrap();
        assert_eq!(wait_for_log(&log, 2).await, vec!["stop", "yielding"]);
        lanes.finish().await;
    }

    /// A Stop sent after a follow-up prompt must not overtake it: the prompt
    /// would reach a runtime already stopped and start a new turn.
    #[tokio::test]
    async fn a_stop_waits_for_an_earlier_command_that_keeps_it_out() {
        let (mut lanes, log, release) = recording_lanes();
        lanes
            .route(envelope("prompt.send", "blocked"))
            .await
            .unwrap();
        lanes.route(envelope("interrupt", "stop")).await.unwrap();
        stays_unrun(&log, 0).await;

        release.send(()).unwrap();
        assert_eq!(wait_for_log(&log, 2).await, vec!["blocked", "stop"]);
        lanes.finish().await;
    }

    #[tokio::test]
    async fn a_panicking_handler_ends_the_lanes_at_once() {
        let (mut lanes, _log, _release) = recording_lanes();
        let ended = lanes.ended();
        lanes.route(envelope("model.set", "panics")).await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), ended.notified())
            .await
            .expect("the lane's end is signalled");
    }

    #[test]
    fn letting_controls_through_off_a_lane_does_nothing() {
        let_controls_through();
    }

    #[tokio::test]
    async fn a_command_waits_for_the_controls_received_before_it() {
        let (mut lanes, log, release) = recording_lanes();
        lanes.route(envelope("model.set", "before")).await.unwrap();
        lanes.route(envelope("interrupt", "blocked")).await.unwrap();
        lanes.route(envelope("prompt.send", "after")).await.unwrap();

        assert_eq!(wait_for_log(&log, 1).await, vec!["before"]);
        stays_unrun(&log, 1).await;

        release.send(()).unwrap();
        assert_eq!(
            wait_for_log(&log, 3).await,
            vec!["before", "blocked", "after"]
        );
        lanes.finish().await;
    }

    #[tokio::test]
    async fn finishing_runs_every_command_already_received() {
        let (mut lanes, log, release) = recording_lanes();
        lanes.route(envelope("init", "blocked")).await.unwrap();
        lanes
            .route(envelope("prompt.send", "prompt"))
            .await
            .unwrap();
        lanes.route(envelope("gate.close", "gate")).await.unwrap();
        release.send(()).unwrap();

        lanes.finish().await;

        let entries = log.lock().await.clone();
        assert_eq!(entries.len(), 3);
        let position = |id: &str| entries.iter().position(|entry| entry == id).unwrap();
        assert!(position("blocked") < position("prompt"));
    }

    #[tokio::test]
    async fn dropping_the_lanes_cancels_the_running_command() {
        let (mut lanes, log, _release) = recording_lanes();
        lanes.route(envelope("compact", "blocked")).await.unwrap();
        tokio::task::yield_now().await;
        let workers: Vec<_> = lanes.workers.iter().map(JoinHandle::abort_handle).collect();

        drop(lanes);

        tokio::time::timeout(Duration::from_secs(1), async {
            while !workers.iter().all(tokio::task::AbortHandle::is_finished) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(log.lock().await.is_empty());
    }
}
