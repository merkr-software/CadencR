//! Stopping a Codex turn: interrupt the root turn and every live child's,
//! then end the commands those turns started, which Codex keeps running past
//! `turn/interrupt` (see `turn_commands`).

use crate::shared::discard::IgnoreClosed;
use std::future::Future;
use std::sync::atomic::Ordering;

use codex_app_server_sdk_rs::{CodexAppServerClient, SdkError};
use futures::{stream, StreamExt};

use super::super::events::provider_error_event;
use super::super::timeouts::{sdk_control_timeout, sdk_interrupt_timeout, TURN_START_WAIT_TIMEOUT};
use super::super::turn_commands::TurnCommand;
use super::CodexSession;
use crate::domain::agents::adapter::RuntimeError;

pub(super) const CODEX_COMMAND_NOT_STOPPED: &str = "CODEX_COMMAND_NOT_STOPPED";

pub(super) struct InterruptTarget {
    pub thread: String,
    pub turn: Option<String>,
    pub fallback: bool,
}

enum InterruptOutcome {
    Ok,
    NothingToInterrupt,
    TimedOut(String),
    Failed(RuntimeError),
}

impl CodexSession {
    pub(super) async fn terminate_unresponsive_stop_session(&self, reason: String) -> bool {
        if self.closing.swap(true, Ordering::SeqCst) {
            return true;
        }
        tracing::warn!(thread_id = %self.thread_id, "{reason}");
        self.async_questions.lock().await.clear();
        self.local_tx
            .send(Err(RuntimeError::stop_escalated(reason)))
            .ignore_closed();
        self.client.shutdown().await;
        true
    }

    pub(super) async fn interrupt_session(&self) -> Result<(), RuntimeError> {
        self.interrupts.fetch_add(1, Ordering::SeqCst);
        // A turn being started has no id yet: wait for `turn/start` to give
        // it, or the stop would target the previous turn and miss this one.
        // Bound the wait so a frozen app-server cannot deadlock Stop.
        let targets = match tokio::time::timeout(TURN_START_WAIT_TIMEOUT, self.turn_start.lock())
            .await
        {
            Ok(_started) => self.interrupt_targets().await,
            Err(_) => {
                self.terminate_unresponsive_stop_session(
                    "Codex did not respond while starting a turn during Stop; its process was terminated."
                        .to_string(),
                )
                .await;
                return Ok(());
            }
        };
        // Before the interrupt: its `turn/completed` forgets the turn's commands.
        let commands = {
            let started = self.turn_commands.lock().expect("turn commands lock");
            targets
                .iter()
                .flat_map(|target| started.started_by(&target.thread, target.turn.as_deref()))
                .collect::<Vec<_>>()
        };
        let interrupted = match interrupt_turns(&self.client, targets).await {
            InterruptOutcome::TimedOut(detail) => {
                self.terminate_unresponsive_stop_session(format!(
                    "Codex did not respond to Stop ({detail}); its process was terminated."
                ))
                .await;
                return Ok(());
            }
            InterruptOutcome::Ok => Ok(()),
            InterruptOutcome::NothingToInterrupt => Err(RuntimeError::NothingToInterrupt),
            InterruptOutcome::Failed(error) => Err(error),
        };
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
async fn interrupt_turns(
    client: &CodexAppServerClient,
    targets: Vec<InterruptTarget>,
) -> InterruptOutcome {
    match targets.as_slice() {
        [] => return InterruptOutcome::NothingToInterrupt,
        [InterruptTarget {
            thread,
            turn: Some(turn),
            fallback: true,
        }] => {
            let interrupted =
                sdk_interrupt_timeout("Codex turn/interrupt", client.turn_interrupt(thread, turn))
                    .await;
            return match interrupted {
                Ok(()) => InterruptOutcome::Ok,
                Err(error) if error.is_no_active_turn_to_interrupt() => {
                    InterruptOutcome::NothingToInterrupt
                }
                Err(SdkError::Timeout(operation)) => {
                    InterruptOutcome::TimedOut(format!("{operation} timed out"))
                }
                Err(error) => InterruptOutcome::Failed(RuntimeError::from(error)),
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
            result.map_err(|error| (target.thread, error))
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
) -> Result<(), SdkError> {
    let turn = match &target.turn {
        Some(turn) => turn.clone(),
        None => {
            // Status-only/reloaded children may never send turn/started on this
            // connection. Read only on Stop, not on the streaming hot path.
            let snapshot = sdk_interrupt_timeout(
                "Codex thread/read (interrupt)",
                client.thread_read(&target.thread, true),
            )
            .await?;
            last_turn_id(&snapshot)?
        }
    };
    sdk_interrupt_timeout(
        "Codex turn/interrupt",
        client.turn_interrupt(&target.thread, &turn),
    )
    .await
}

fn last_turn_id(snapshot: &codex_app_server_sdk_rs::ThreadSnapshot) -> Result<String, SdkError> {
    snapshot
        .turns
        .last()
        .map(|turn| turn.id.clone())
        .ok_or_else(|| {
            SdkError::Protocol("Active Codex child has no turn to interrupt; retry Stop".into())
        })
}

async fn interrupt_all<T, F, Fut>(targets: Vec<T>, send: F) -> InterruptOutcome
where
    F: FnMut(T) -> Fut,
    Fut: Future<Output = Result<(), (String, SdkError)>>,
{
    let mut pending = stream::iter(targets).map(send).buffer_unordered(8);
    let mut failures = Vec::new();
    while let Some(result) = pending.next().await {
        let Err((thread, error)) = result else {
            continue;
        };
        if let SdkError::Timeout(operation) = error {
            return InterruptOutcome::TimedOut(format!("{thread}: {operation} timed out"));
        }
        failures.push(format!("{thread}: {error}"));
    }
    if failures.is_empty() {
        InterruptOutcome::Ok
    } else {
        InterruptOutcome::Failed(RuntimeError::new(format!(
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
                Err((thread.to_string(), SdkError::Protocol(thread.to_string())))
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
        let InterruptOutcome::Failed(error) = result else {
            panic!("expected Failed outcome");
        };
        let error = error.to_string();
        for thread in ["slow-child", "root", "other-child"] {
            assert!(error.contains(thread));
        }
    }

    #[tokio::test]
    async fn timeout_outcome_is_classified_for_stop_escalation() {
        let outcome = interrupt_all(vec!["root"], |thread| async move {
            Err((
                thread.to_string(),
                SdkError::Timeout("Codex turn/interrupt"),
            ))
        })
        .await;
        assert!(matches!(outcome, InterruptOutcome::TimedOut(detail) if detail.contains("root")));
    }

    #[tokio::test]
    async fn successful_or_empty_interrupt_sets_succeed() {
        assert!(matches!(
            interrupt_all(vec![1, 2], |_| async { Ok(()) }).await,
            InterruptOutcome::Ok
        ));
        assert!(matches!(
            interrupt_all(Vec::<u8>::new(), |_| async { Ok(()) }).await,
            InterruptOutcome::Ok
        ));
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
