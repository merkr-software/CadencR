//! Per-request routing of user permission responses to the runtime callback
//! that is waiting for them.
//!
//! A runtime can hold several permission requests open at once (Claude Code
//! dispatches each `can_use_tool` control request on its own task). Every
//! waiter registers its request id *before* the request is shown to the user,
//! and a response is delivered only to the waiter whose id it names, so the
//! answer to request B can never resolve request A.
//!
//! The sender half mirrors `mpsc` closure semantics: once every
//! [`PermissionResponseSender`] clone is dropped, pending and future waiters
//! resolve to `None` ("channel closed").

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::oneshot;

use super::bridge::PermissionResponse;

#[derive(Default)]
struct RouterState {
    closed: bool,
    next_token: u64,
    waiters: HashMap<String, (u64, oneshot::Sender<PermissionResponse>)>,
}

#[derive(Default)]
struct Shared {
    state: Mutex<RouterState>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, RouterState> {
        // The guarded map holds no invariant a panicking holder could break
        // half-way, so a poisoned lock is still safe to use.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Closes the router when the last sender clone is dropped.
struct SenderLifetime {
    shared: Arc<Shared>,
}

impl Drop for SenderLifetime {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        state.closed = true;
        // Dropping the oneshot senders wakes every waiter with `None`.
        state.waiters.clear();
    }
}

/// Response side, held by the session's active runtime state.
#[derive(Clone)]
pub struct PermissionResponseSender {
    lifetime: Arc<SenderLifetime>,
}

/// Request side, held by the runtime permission callback.
#[derive(Clone)]
pub struct PermissionResponseWaiters {
    shared: Arc<Shared>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDeliveryError {
    /// The runtime callback side is gone (session closed).
    Closed,
    /// No open permission request carries this id.
    UnknownRequest(String),
}

impl std::fmt::Display for PermissionDeliveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => write!(f, "Permission channel closed"),
            Self::UnknownRequest(id) => {
                write!(f, "No open permission request matches request_id `{id}`")
            }
        }
    }
}

pub fn permission_response_channel() -> (PermissionResponseSender, PermissionResponseWaiters) {
    let shared = Arc::new(Shared::default());
    let sender = PermissionResponseSender {
        lifetime: Arc::new(SenderLifetime {
            shared: Arc::clone(&shared),
        }),
    };
    (sender, PermissionResponseWaiters { shared })
}

impl PermissionResponseSender {
    /// Deliver `response` to the waiter registered under its `request_id`.
    pub fn deliver(&self, response: PermissionResponse) -> Result<(), PermissionDeliveryError> {
        let shared = &self.lifetime.shared;
        let waiter = {
            let mut state = shared.lock();
            if state.closed {
                return Err(PermissionDeliveryError::Closed);
            }
            state.waiters.remove(&response.request_id)
        };
        let Some((_, tx)) = waiter else {
            return Err(PermissionDeliveryError::UnknownRequest(response.request_id));
        };
        let request_id = response.request_id.clone();
        tx.send(response)
            .map_err(|_| PermissionDeliveryError::UnknownRequest(request_id))
    }
}

impl PermissionResponseWaiters {
    /// Register interest in `request_id`. Must be called before the request
    /// reaches any client so no response can arrive unrouted.
    pub fn register(&self, request_id: &str) -> PermissionWaiter {
        let (tx, rx) = oneshot::channel();
        let mut state = self.shared.lock();
        let token = state.next_token;
        state.next_token += 1;
        if !state.closed {
            if let Some((_, replaced)) = state.waiters.insert(request_id.to_string(), (token, tx)) {
                // A duplicate id resolves the older waiter as closed rather
                // than letting it steal the newer request's answer.
                drop(replaced);
                tracing::warn!(request_id, "permission request id registered twice");
            }
        }
        PermissionWaiter {
            shared: Arc::clone(&self.shared),
            request_id: request_id.to_string(),
            token,
            rx: Some(rx),
        }
    }
}

/// One open permission request awaiting its own response.
pub struct PermissionWaiter {
    shared: Arc<Shared>,
    request_id: String,
    token: u64,
    rx: Option<oneshot::Receiver<PermissionResponse>>,
}

impl PermissionWaiter {
    /// `None` when the session closed before this request was answered.
    pub async fn recv(mut self) -> Option<PermissionResponse> {
        let rx = self.rx.take()?;
        rx.await.ok()
    }
}

impl Drop for PermissionWaiter {
    fn drop(&mut self) {
        // A cancelled callback must not leave a stale entry that would swallow
        // a later response, so remove our registration if it is still ours.
        let mut state = self.shared.lock();
        if state
            .waiters
            .get(&self.request_id)
            .is_some_and(|(token, _)| *token == self.token)
        {
            state.waiters.remove(&self.request_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::protocol::PermissionDecision;

    fn response(request_id: &str, decision: PermissionDecision) -> PermissionResponse {
        PermissionResponse {
            request_id: request_id.to_string(),
            message_uuid: None,
            decision,
            option_id: None,
            feedback: None,
            updated_input: None,
            is_approval_gate: false,
        }
    }

    #[tokio::test]
    async fn response_to_second_request_never_resolves_first() {
        let (sender, waiters) = permission_response_channel();
        let first = waiters.register("req-a");
        let second = waiters.register("req-b");

        sender
            .deliver(response("req-b", PermissionDecision::Deny))
            .expect("req-b is open");
        let second = second.recv().await.expect("req-b answered");
        assert_eq!(second.request_id, "req-b");
        assert_eq!(second.decision, PermissionDecision::Deny);

        let first_task = tokio::spawn(first.recv());
        tokio::task::yield_now().await;
        assert!(!first_task.is_finished(), "req-a must still be waiting");

        sender
            .deliver(response("req-a", PermissionDecision::AllowOnce))
            .expect("req-a is open");
        let first = first_task.await.unwrap().expect("req-a answered");
        assert_eq!(first.request_id, "req-a");
        assert_eq!(first.decision, PermissionDecision::AllowOnce);
    }

    #[tokio::test]
    async fn unknown_request_id_is_rejected_not_applied() {
        let (sender, waiters) = permission_response_channel();
        let open = waiters.register("req-a");
        assert_eq!(
            sender.deliver(response("req-z", PermissionDecision::AllowOnce)),
            Err(PermissionDeliveryError::UnknownRequest("req-z".into()))
        );
        sender
            .deliver(response("req-a", PermissionDecision::Deny))
            .unwrap();
        assert_eq!(open.recv().await.unwrap().request_id, "req-a");
    }

    #[tokio::test]
    async fn dropping_every_sender_closes_pending_and_future_waiters() {
        let (sender, waiters) = permission_response_channel();
        let pending = waiters.register("req-a");
        let clone = sender.clone();
        drop(sender);
        assert!(clone
            .deliver(response("req-missing", PermissionDecision::Deny))
            .is_err());
        drop(clone);
        assert!(pending.recv().await.is_none());
        assert!(waiters.register("req-b").recv().await.is_none());
    }

    #[tokio::test]
    async fn cancelled_waiter_unregisters_itself() {
        let (sender, waiters) = permission_response_channel();
        drop(waiters.register("req-a"));
        assert_eq!(
            sender.deliver(response("req-a", PermissionDecision::AllowOnce)),
            Err(PermissionDeliveryError::UnknownRequest("req-a".into()))
        );
    }

    #[tokio::test]
    async fn duplicate_registration_keeps_newest_waiter() {
        let (sender, waiters) = permission_response_channel();
        let older = waiters.register("req-a");
        let newer = waiters.register("req-a");
        assert!(older.recv().await.is_none());
        sender
            .deliver(response("req-a", PermissionDecision::AllowOnce))
            .unwrap();
        assert!(newer.recv().await.is_some());
    }
}
