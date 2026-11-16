use std::future::Future;

use codex_app_server_sdk_rs::CodexAppServerClient;
use futures::{stream, StreamExt};

use super::super::timeouts::with_control_timeout;
use crate::domain::agents::adapter::RuntimeError;

pub(super) struct InterruptTarget {
    pub thread: String,
    pub turn: Option<String>,
    pub fallback: bool,
}

pub(super) async fn interrupt_turns(
    client: &CodexAppServerClient,
    targets: Vec<InterruptTarget>,
) -> Result<(), RuntimeError> {
    interrupt_all(targets, |target| async move {
        let result = interrupt_target(client, &target).await;
        // Preserve the historical root fallback: that turn may already be gone.
        if target.fallback {
            Ok(())
        } else {
            result.map_err(|error| RuntimeError::new(format!("{}: {error}", target.thread)))
        }
    })
    .await
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
