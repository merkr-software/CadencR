//! Named ways to drop a `Result` on purpose.
//!
//! The crate denies `clippy::let_underscore_must_use` (see `lib.rs`), so a bare
//! `let _ = fallible();` does not compile. An intentional discard goes through
//! one of these helpers instead, which states why nobody needs the error, or
//! carries a `#[expect(..., reason = "...")]` when no helper fits.

use std::fmt::Display;
use std::panic::Location;

use tokio::sync::{broadcast, mpsc, oneshot, watch};

/// A channel send whose only failure is "the receiver hung up": the
/// connection, turn or task it served has ended, so there is nobody left to
/// deliver to. Bounded `try_send` is deliberately absent: a full channel drops
/// a live message, which is a real failure.
pub trait IgnoreClosed {
    fn ignore_closed(self);
}

impl<T> IgnoreClosed for Result<(), mpsc::error::SendError<T>> {
    fn ignore_closed(self) {}
}

/// Fails only when no subscriber is listening right now.
impl<T> IgnoreClosed for Result<usize, broadcast::error::SendError<T>> {
    fn ignore_closed(self) {}
}

impl<T> IgnoreClosed for Result<(), watch::error::SendError<T>> {
    fn ignore_closed(self) {}
}

impl<T> IgnoreClosed for Result<(), std::sync::mpsc::SendError<T>> {
    fn ignore_closed(self) {}
}

/// Waiting for a signal whose sender may be dropped instead of fired: both end
/// the wait the same way.
impl<T> IgnoreClosed for Result<T, oneshot::error::RecvError> {
    fn ignore_closed(self) {}
}

impl<T> IgnoreClosed for Result<T, watch::error::RecvError> {
    fn ignore_closed(self) {}
}

/// A WebSocket write fails once the peer's connection is gone; the socket's
/// read loop observes the same loss and ends the session.
impl IgnoreClosed for Result<(), axum::Error> {
    fn ignore_closed(self) {}
}

/// `oneshot::Sender::send` returns the unsent value itself as its error, so
/// it cannot share [`IgnoreClosed`] without also accepting every `Result`.
pub trait SendIgnoreClosed<T> {
    /// Answers a waiter that may have stopped waiting.
    fn send_ignore_closed(self, value: T);
}

impl<T> SendIgnoreClosed<T> for oneshot::Sender<T> {
    fn send_ignore_closed(self, value: T) {
        // The waiter dropped its receiver: the value has nowhere to go.
        drop(self.send(value));
    }
}

/// A value set once per process (or per object) that later calls must not
/// replace: the first one wins and a later one is dropped on purpose.
pub trait KeepFirst<T> {
    fn keep_first(&self, value: T);
}

impl<T> KeepFirst<T> for std::sync::OnceLock<T> {
    fn keep_first(&self, value: T) {
        // Already set: the first value stays, this one is dropped.
        drop(self.set(value));
    }
}

/// Cleanup whose failure leaves nothing for anyone to act on: killing a child
/// that may already have exited, removing a temporary file, waiting for a task
/// that is being torn down. The failure is still logged at debug level with
/// the caller's location, for diagnosis. Only the outer error is logged: for
/// `timeout(.., fut)` that is the deadline, not `fut`'s own result.
#[track_caller]
pub fn cleanup<T, E: Display>(result: Result<T, E>, what: &str) {
    if let Err(error) = result {
        let caller = Location::caller();
        tracing::debug!(
            caller = %format_args!("{}:{}", caller.file(), caller.line()),
            "cleanup step failed ({what}): {error}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_receivers_are_ignored() {
        let (tx, rx) = mpsc::unbounded_channel::<u8>();
        drop(rx);
        tx.send(1).ignore_closed();

        let (tx, rx) = oneshot::channel::<u8>();
        drop(rx);
        tx.send_ignore_closed(1);
    }

    #[test]
    fn delivered_values_still_arrive() {
        let (tx, mut rx) = mpsc::unbounded_channel::<u8>();
        tx.send(7).ignore_closed();
        assert_eq!(rx.try_recv().ok(), Some(7));

        let (tx, mut rx) = oneshot::channel::<u8>();
        tx.send_ignore_closed(9);
        assert_eq!(rx.try_recv().ok(), Some(9));
    }

    #[test]
    fn the_first_value_is_kept() {
        let cell = std::sync::OnceLock::new();
        cell.keep_first(1);
        cell.keep_first(2);
        assert_eq!(cell.get(), Some(&1));
    }

    #[test]
    fn cleanup_accepts_failures() {
        cleanup(Err::<(), _>("already gone"), "test step");
        cleanup(Ok::<_, String>(()), "test step");
    }
}
