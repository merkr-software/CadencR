//! Stopping a Codex turn: interrupt the root turn and every live child's,
//! then end the commands those turns started, which Codex keeps running past
//! `turn/interrupt` (see `turn_commands`).

use crate::shared::discard::IgnoreClosed;
use std::future::Future;
use std::sync::atomic::Ordering;

use codex_app_server_sdk_rs::CodexAppServerClient;
use futures::{stream, StreamExt};

use super::super::events::provider_error_event;
use super::super::timeouts::{sdk_control_timeout, with_control_timeout};
use super::super::turn_commands::TurnCommand;
use super::CodexSession;
use crate::domain::agents::adapter::RuntimeError;

pub(super) const CODEX_COMMAND_NOT_STOPPED: &str = "CODEX_COMMAND_NOT_STOPPED";

pub(super) struct InterruptTarget {
    pub thread: String,
    pub turn: Option<String>,
    pub fallback: bool,
}

impl CodexSession {
    pub(super) async fn interrupt_session(&self) -> Result<(), RuntimeError> {
        self.interrupts.fetch_add(1, Ordering::SeqCst);
        // A turn being started has no id yet: wait for `turn/start` to give
        // it, or the stop would target the previous turn and miss this one.
        let targets = {
            let _started = self.turn_start.lock().await;
            self.interrupt_targets().await
        };
        // Before the interrupt: its `turn/completed` forgets the turn's commands.
        let commands = {
            let started = self.turn_commands.lock().expect("turn commands lock");
            targets
                .iter()
                .flat_map(|target| started.started_by(&target.thread, target.turn.as_deref()))
                .collect::<Vec<_>>()
        };
        let interrupted = interrupt_turns(&self.client, targets).await;
        if let Some(failure) = stop_commands(&self.client, commands).await {
            let event = provider_error_event(&self.thread_id, failure, CODEX_COMMAND_NOT_STOPPED);
            // A closed stream means the session is gone, its commands with it.
            self.local_tx.send(Ok(event)).ignore_closed();
        }
        interrupted?;
        self.async_questions.lock().await.clear();
        Ok(())
    }

    async fn interrupt_targets(&self) -> Vec<InterruptTarget> {
        // Snapshot before awaiting RPCs; completion events keep updating the tracker.
        let children = self.child_turn_ids.read().await.clone();
        let root_turn = self.active_turn_id.read().await.clone();
        let root_fallback = self.last_root_turn_id.read().await.clone();
        let mut targets = Vec::with_capacity(children.len() + 1);
        let fallback = root_turn.is_none();
        if let Some(turn) = root_turn.or(root_fallback) {
            targets.push(InterruptTarget {
                thread: self.thread_id.clone(),
                turn: Some(turn),
                fallback,
            });
        }
        targets.extend(children.into_iter().map(|(thread, turn)| InterruptTarget {
            thread,
            turn,
            fallback: false,
        }));
        targets
    }
}

/// Interrupt every target. When the only target is the root's last turn
/// (`fallback`: no turn is known to run), Codex refusing it ("no active turn
/// to interrupt") means nothing was stopped and no stopped turn will be
/// reported.
pub(super) async fn interrupt_turns(
    client: &CodexAppServerClient,
    targets: Vec<InterruptTarget>,
) -> Result<(), RuntimeError> {
    match targets.as_slice() {
        [] => return Err(RuntimeError::NothingToInterrupt),
        [InterruptTarget {
            thread,
            turn: Some(turn),
            fallback: true,
        }] => {
            let interrupted =
                sdk_control_timeout("Codex turn/interrupt", client.turn_interrupt(thread, turn))
                    .await;
            return match interrupted {
                Err(error) if error.is_no_active_turn_to_interrupt() => {
                    Err(RuntimeError::NothingToInterrupt)
                }
                result => result.map_err(RuntimeError::from),
            };
        }
        _ => {}
    }
    interrupt_all(targets, |target| async move {
        let result = interrupt_target(client, &target).await;
        // A child may still run while the root's turn already ended.
        if target.fallback {
            Ok(())
        } else {
            result.map_err(|error| RuntimeError::new(format!("{}: {error}", target.thread)))
        }
    })
    .await
}

/// End the commands the interrupted turns started, a few at a time. Returns
/// why some that may still run could not be stopped.
async fn stop_commands(
    client: &CodexAppServerClient,
    commands: Vec<TurnCommand>,
) -> Option<String> {
    const METHOD: &str = "thread/backgroundTerminals/terminate";
    let results: Vec<_> = stream::iter(commands)
        .map(|command| async move {
            let stopped = sdk_control_timeout(
                METHOD,
                client.thread_background_terminal_terminate(&command.thread, &command.process),
            )
            .await;
            // `Ok(false)`: the command had already ended.
            (command.process, stopped.err())
        })
        .buffer_unordered(8)
        .collect()
        .await;
    let mut failures = Vec::new();
    for (process, error) in results {
        match error {
            None => {}
            // An app-server without background terminals ends a turn's
            // commands with the turn: none is left to stop.
            Some(error) if error.is_unknown_method(METHOD) => {
                tracing::info!(%error, "Codex app-server has no background terminals to stop");
                return None;
            }
            Some(error) => failures.push(format!("process {process}: {error}")),
        }
    }
    (!failures.is_empty()).then(|| {
        format!(
            "The turn stopped, but Codex could not stop commands it started ({})",
            failures.join("; ")
        )
    })
}

async fn interrupt_target(
    client: &CodexAppServerClient,
    target: &InterruptTarget,
) -> Result<(), RuntimeError> {
    let turn = match &target.turn {
        Some(turn) => turn.clone(),
        None => {
            // Status-only/reloaded children may never send turn/started on this
            // connection. Read only on Stop, not on the streaming hot path.
            let snapshot = with_control_timeout(
                "Codex thread/read (interrupt)",
                client.thread_read(&target.thread, true),
            )
            .await?;
            last_turn_id(&snapshot)?
        }
    };
    with_control_timeout(
        "Codex turn/interrupt",
        client.turn_interrupt(&target.thread, &turn),
    )
    .await
}

fn last_turn_id(
    snapshot: &codex_app_server_sdk_rs::ThreadSnapshot,
) -> Result<String, RuntimeError> {
    snapshot
        .turns
        .last()
        .map(|turn| turn.id.clone())
        .ok_or_else(|| RuntimeError::new("Active Codex child has no turn to interrupt; retry Stop"))
}

async fn interrupt_all<T, F, Fut>(targets: Vec<T>, send: F) -> Result<(), RuntimeError>
where
    F: FnMut(T) -> Fut,
    Fut: Future<Output = Result<(), RuntimeError>>,
{
    let failures: Vec<_> = stream::iter(targets)
        .map(send)
        .buffer_unordered(8)
        .filter_map(|result| async { result.err().map(|error| error.to_string()) })
        .collect()
        .await;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(RuntimeError::new(format!(
            "Failed to interrupt Codex turns: {}",
            failures.join("; ")
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use tokio::sync::Notify;

    use super::*;

    #[tokio::test]
    async fn stalled_child_does_not_block_root_or_other_child_and_all_errors_survive() {
        let started = AtomicUsize::new(0);
        let release = Notify::new();
        let requests = interrupt_all(vec!["slow-child", "root", "other-child"], |thread| {
            let started = &started;
            let release = &release;
            async move {
                started.fetch_add(1, Ordering::SeqCst);
                if thread == "slow-child" {
                    release.notified().await;
                }
                Err(RuntimeError::new(thread))
            }
        });
        let observer = async {
            tokio::time::timeout(Duration::from_secs(1), async {
                while started.load(Ordering::SeqCst) != 3 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("all targets must start without waiting for the slow child");
            release.notify_one();
        };
        let (result, ()) = tokio::join!(requests, observer);
        let error = result.unwrap_err().to_string();
        for thread in ["slow-child", "root", "other-child"] {
            assert!(error.contains(thread));
        }
    }

    #[tokio::test]
    async fn successful_or_empty_interrupt_sets_succeed() {
        assert!(interrupt_all(vec![1, 2], |_| async { Ok(()) })
            .await
            .is_ok());
        assert!(interrupt_all(Vec::<u8>::new(), |_| async { Ok(()) })
            .await
            .is_ok());
    }
    #[test]
    fn status_only_child_uses_latest_turn_and_missing_turn_is_an_error() {
        use codex_app_server_sdk_rs::{ThreadSnapshot, ThreadTurn};
        let mut snapshot = ThreadSnapshot {
            id: "child".into(),
            turns: Vec::new(),
        };
        assert!(last_turn_id(&snapshot).is_err());
        snapshot.turns = vec![
            ThreadTurn::new("old".into(), 0),
            ThreadTurn::new("active".into(), 0),
        ];
        assert_eq!(last_turn_id(&snapshot).unwrap(), "active");
    }
}
