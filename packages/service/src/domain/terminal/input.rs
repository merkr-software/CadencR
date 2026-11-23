//! Client input on one PTY socket (terminal or Neovim), kept apart from the
//! socket's read loop.
//!
//! A write to a child that is not reading stdin waits for room in the PTY's
//! input queue, possibly forever. The read loop therefore never awaits a
//! write: it hands input to an [`InputPump`] and goes back to reading, so
//! kill, resize and detach are applied at once whatever the input is doing.
//! The pump runs one write at a time, in arrival order, and is polled from a
//! `select!` arm next to the socket.
//!
//! Memory stays bounded by a per-socket budget. Input past it is refused
//! with an error the client shows, rather than by pausing the read loop:
//! pausing would hold back the control messages that share the socket.
//!
//! Input still pending when its socket closes (a keystroke sent right before
//! Detach or Close) is finished by a detached task, see
//! [`InputPump::finish_detached`].

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;

use super::service::PtyManager;

type WriteFuture = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>>;
type StartWrite = Box<dyn Fn(Vec<u8>) -> WriteFuture + Send>;

/// What one socket may hold for a child that is not reading: room for a very
/// large paste on top of the PTY's own 512 KiB queue.
pub(crate) const SOCKET_INPUT_BUDGET: usize = 16 * 1024 * 1024;
/// Charged per write on top of its bytes (queue slot, allocation, future), so
/// a flood of one-byte writes is bounded as well.
const ENTRY_OVERHEAD: usize = 64;

pub(crate) struct InputPump {
    start_write: StartWrite,
    in_flight: Option<(usize, WriteFuture)>,
    queued: VecDeque<Vec<u8>>,
    /// Budget used by queued and in-flight writes.
    held: usize,
    budget: usize,
}

impl InputPump {
    /// `start_write` turns one client write into the future that delivers it.
    pub(crate) fn new<F, Fut>(budget: usize, start_write: F) -> Self
    where
        F: Fn(Vec<u8>) -> Fut + Send + 'static,
        Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        Self {
            start_write: Box::new(move |data| Box::pin(start_write(data))),
            in_flight: None,
            queued: VecDeque::new(),
            held: 0,
            budget,
        }
    }

    /// The pump of one socket attached to `pty_id`.
    pub(crate) fn for_pty(manager: &PtyManager, pty_id: &str) -> Self {
        let manager = manager.clone();
        let pty_id = pty_id.to_string();
        Self::new(SOCKET_INPUT_BUDGET, move |data| {
            manager.write_pty(&pty_id, data)
        })
    }

    /// Queue client input behind what is already pending. Never waits. Fails,
    /// keeping nothing of `data`, when the socket's budget would be exceeded;
    /// the caller reports that to the client.
    pub(crate) fn push(&mut self, data: Vec<u8>) -> anyhow::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        let cost = data.len() + ENTRY_OVERHEAD;
        let limit_mib = self.budget / (1024 * 1024);
        if cost > self.budget {
            anyhow::bail!(
                "input refused: {} KiB is more than one connection may hand a process at once \
                 (limit {limit_mib} MiB)",
                data.len() / 1024
            );
        }
        if self.held + cost > self.budget {
            anyhow::bail!(
                "input refused: {} KiB are still waiting for the process to read them \
                 (limit {limit_mib} MiB per connection)",
                self.held / 1024
            );
        }
        self.held += cost;
        if self.in_flight.is_none() {
            self.start(data);
        } else {
            self.queued.push_back(data);
        }
        Ok(())
    }

    /// Resolves with each write's result as it finishes, then starts the next
    /// one; never resolves while idle, so it can sit in a `select!` arm.
    /// Cancel-safe: dropping this future leaves the write in flight.
    ///
    /// A failed write means the PTY takes no more input (it exited, or its
    /// writer failed): the writes queued behind it are dropped and counted in
    /// that one error instead of failing one by one.
    pub(crate) async fn next_result(&mut self) -> anyhow::Result<()> {
        let Some((_, write)) = self.in_flight.as_mut() else {
            return std::future::pending().await;
        };
        let result = write.await;
        if let Some((cost, _)) = self.in_flight.take() {
            self.held -= cost;
        }
        if let Err(error) = result {
            let discarded = self.queued.len();
            self.queued.clear();
            self.held = 0;
            return Err(match discarded {
                0 => error,
                n => error.context(format!("{n} later write(s) discarded")),
            });
        }
        if let Some(next) = self.queued.pop_front() {
            self.start(next);
        }
        Ok(())
    }

    /// Deliver what is still pending after the socket closed, so a keystroke
    /// sent right before Detach or Close still reaches the process. The task
    /// ends once everything is delivered or the PTY stops taking input. No
    /// client is left to tell about a failure, so it is logged.
    pub(crate) fn finish_detached(mut self, pty_id: String) {
        if self.in_flight.is_none() {
            return;
        }
        tokio::spawn(async move {
            while self.in_flight.is_some() {
                if let Err(error) = self.next_result().await {
                    let error = format!("{error:#}");
                    tracing::warn!(%pty_id, %error, "input pending at disconnect was not delivered");
                }
            }
        });
    }

    fn start(&mut self, data: Vec<u8>) {
        let cost = data.len() + ENTRY_OVERHEAD;
        self.in_flight = Some((cost, (self.start_write)(data)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::Notify;

    /// A fake PTY: records each write once `gate` lets it through.
    fn recording_pump(
        budget: usize,
        gate: Arc<Notify>,
        log: Arc<Mutex<Vec<Vec<u8>>>>,
    ) -> InputPump {
        InputPump::new(budget, move |data: Vec<u8>| {
            let gate = Arc::clone(&gate);
            let log = Arc::clone(&log);
            async move {
                gate.notified().await;
                if data == b"fail" {
                    anyhow::bail!("write failed");
                }
                log.lock().unwrap().push(data);
                Ok(())
            }
        })
    }

    #[tokio::test]
    async fn idle_input_never_finishes() {
        let mut pump = recording_pump(1024, Arc::new(Notify::new()), Arc::default());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), pump.next_result())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn push_never_waits_and_a_failure_ends_the_queue_with_one_error() {
        let gate = Arc::new(Notify::new());
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut pump = recording_pump(1024, Arc::clone(&gate), Arc::clone(&log));

        // The first write is stuck; more input still queues without waiting.
        pump.push(b"paste".to_vec()).unwrap();
        pump.push(b"fail".to_vec()).unwrap();
        pump.push(b"\x03".to_vec()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), pump.next_result())
                .await
                .is_err(),
            "nothing finishes while the child does not read"
        );

        let mut results = Vec::new();
        for _ in 0..2 {
            gate.notify_one();
            results.push(pump.next_result().await.map_err(|e| format!("{e:#}")));
        }
        assert_eq!(
            results,
            vec![
                Ok(()),
                Err("1 later write(s) discarded: write failed".to_string())
            ]
        );
        assert_eq!(*log.lock().unwrap(), vec![b"paste".to_vec()]);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), pump.next_result())
                .await
                .is_err(),
            "nothing is left in flight"
        );
        pump.push(vec![b'x'; 900])
            .expect("the failure released the whole budget");
    }

    #[tokio::test]
    async fn input_past_the_budget_is_refused_and_room_comes_back() {
        let gate = Arc::new(Notify::new());
        let budget = 2 * ENTRY_OVERHEAD + 8;
        let mut pump = recording_pump(budget, Arc::clone(&gate), Arc::default());
        pump.push(vec![b'a'; 6]).unwrap();
        let refused = pump.push(vec![b'b'; 3]).unwrap_err().to_string();
        assert!(refused.contains("still waiting"), "{refused}");
        pump.push(vec![b'c'; 2]).expect("still within the budget");
        let too_big = pump.push(vec![b'e'; budget]).unwrap_err().to_string();
        assert!(too_big.contains("more than one connection"), "{too_big}");

        gate.notify_one();
        pump.next_result().await.unwrap();
        pump.push(vec![b'd'; 6])
            .expect("the delivered bytes free the budget");
    }

    #[tokio::test]
    async fn every_write_costs_budget_so_one_byte_floods_stay_bounded() {
        let mut pump = recording_pump(10 * ENTRY_OVERHEAD, Arc::new(Notify::new()), Arc::default());
        let accepted = (0..100)
            .filter(|_| pump.push(b"x".to_vec()).is_ok())
            .count();
        assert!(accepted < 10, "accepted {accepted} one-byte writes");
    }

    #[tokio::test]
    async fn input_pending_at_disconnect_is_still_delivered() {
        let gate = Arc::new(Notify::new());
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut pump = recording_pump(1024, Arc::clone(&gate), Arc::clone(&log));
        pump.push(b":w\r".to_vec()).unwrap();
        pump.push(b"ZZ".to_vec()).unwrap();

        // The socket is gone before the pump ever polled its writes.
        pump.finish_detached("test".to_string());
        tokio::time::timeout(Duration::from_secs(2), async {
            while log.lock().unwrap().len() < 2 {
                gate.notify_one();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("pending input delivered after the disconnect");
        assert_eq!(*log.lock().unwrap(), vec![b":w\r".to_vec(), b"ZZ".to_vec()]);
    }
}
