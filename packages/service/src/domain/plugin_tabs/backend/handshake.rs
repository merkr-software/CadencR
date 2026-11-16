//! The `ready` handshake (protocol 1): after the host writes `hello`, the
//! backend's first stdout line must be `{"type":"ready","protocol":1}` (other
//! fields, such as `"sdk"`, are ignored) within [`READY_TIMEOUT`] (host
//! leniency: [`FIRST_READY_TIMEOUT`] for a binary's first start). Until then
//! no request is written; a backend that never says it is ready, or names
//! another protocol, is stopped and every waiting request fails with why.

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
pub use cadencr_tab_backend::protocol::READY_TIMEOUT;
use cadencr_tab_backend::protocol::{parse_ready, ReadyProblem};
use tokio::sync::watch;

use crate::domain::plugin_tabs::activity::cut;
use crate::error::AppError;

/// The budget of a binary's first start in this Cadencr process (see
/// [`super::first_start`]): macOS assesses a freshly written executable on
/// its first launch, which can take seconds before its `main` runs. Host
/// leniency only — the protocol still requires `ready` within 5 s.
pub const FIRST_READY_TIMEOUT: Duration = Duration::from_secs(20);
/// Characters of an unexpected first line quoted back in an error.
const MAX_QUOTED_CHARS: usize = 200;

/// Where one run is in its handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Handshake {
    Waiting,
    Ready,
    Failed(HandshakeFailure),
}

/// Why a run never became ready, as the user is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HandshakeFailure {
    pub kind: FailureKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FailureKind {
    /// No `ready` line within the run's budget ([`READY_TIMEOUT`]).
    NotReady,
    /// A first line that is not `ready` for the declared protocol.
    /// Deterministic: retrying the same binary cannot succeed.
    ProtocolMismatch,
    /// The process exited before it was ready.
    Exited,
}

impl HandshakeFailure {
    pub fn not_ready(budget: Duration) -> Self {
        Self {
            kind: FailureKind::NotReady,
            message: format!(
                "the tab's backend did not write its `ready` line within {} s",
                budget.as_secs()
            ),
        }
    }

    pub fn exited(reason: &str) -> Self {
        Self {
            kind: FailureKind::Exited,
            message: format!("the tab's backend {reason} before it was ready"),
        }
    }

    pub fn to_error(&self) -> AppError {
        let (status, code) = match self.kind {
            FailureKind::NotReady => (StatusCode::GATEWAY_TIMEOUT, "PLUGIN_BACKEND_NOT_READY"),
            FailureKind::ProtocolMismatch => {
                (StatusCode::BAD_GATEWAY, "PLUGIN_BACKEND_PROTOCOL_MISMATCH")
            }
            FailureKind::Exited => (StatusCode::BAD_GATEWAY, "PLUGIN_BACKEND_EXITED"),
        };
        AppError::coded(status, code, self.message.clone())
    }
}

/// The handshake state, written by the stdout reader and the supervisor,
/// awaited by requests.
pub(super) type HandshakeState = Arc<watch::Sender<Handshake>>;

pub(super) fn new_state() -> HandshakeState {
    Arc::new(watch::Sender::new(Handshake::Waiting))
}

/// Settle a handshake still waiting; the first outcome wins. `true` when
/// this call settled it.
pub(super) fn settle(state: &HandshakeState, outcome: Handshake) -> bool {
    state.send_if_modified(|current| {
        if *current != Handshake::Waiting {
            return false;
        }
        *current = outcome;
        true
    })
}

/// Wait for the handshake to settle: `Ok` once ready.
pub(super) async fn wait_ready(state: &HandshakeState) -> Result<(), AppError> {
    let mut receiver = state.subscribe();
    let settled = receiver
        .wait_for(|handshake| *handshake != Handshake::Waiting)
        .await
        .map(|handshake| handshake.clone());
    match settled {
        Ok(Handshake::Ready) => Ok(()),
        Ok(Handshake::Failed(failure)) => Err(failure.to_error()),
        // Unreachable while the sender lives in `state`; kept total.
        Ok(Handshake::Waiting) | Err(_) => Err(HandshakeFailure::exited("stopped").to_error()),
    }
}

/// Resolves only if the handshake fails: with the failure, after settling a
/// still-waiting one as [`FailureKind::NotReady`] after `budget`.
pub(super) async fn failed(state: &HandshakeState, budget: Duration) -> HandshakeFailure {
    if !settled_within(state, budget).await {
        settle(
            state,
            Handshake::Failed(HandshakeFailure::not_ready(budget)),
        );
    }
    let current = state.borrow().clone();
    match current {
        Handshake::Failed(failure) => failure,
        // Ready (or, impossibly, still waiting): this never resolves.
        Handshake::Ready | Handshake::Waiting => std::future::pending().await,
    }
}

/// Whether the handshake settled (either way) within `wait`.
pub(super) async fn settled_within(state: &HandshakeState, wait: Duration) -> bool {
    let mut receiver = state.subscribe();
    // `is_ok` drops the borrowed state at once: it must not outlive this.
    tokio::time::timeout(
        wait,
        receiver.wait_for(|handshake| *handshake != Handshake::Waiting),
    )
    .await
    .is_ok_and(|settled| settled.is_ok())
}

/// The outcome of the backend's first stdout line, for a backend declaring
/// `expected`.
pub(super) fn check_ready(line: &[u8], expected: u32) -> Handshake {
    let wanted = format!(r#"{{"type":"ready","protocol":{expected}}}"#);
    let message = match parse_ready(line, expected) {
        Ok(_) => return Handshake::Ready,
        Err(ReadyProblem::NotReady) => format!(
            "the tab's backend does not speak backend protocol {expected}: expected `{wanted}` as its first stdout line, got `{}`",
            cut(&String::from_utf8_lossy(line), MAX_QUOTED_CHARS)
        ),
        Err(ReadyProblem::OtherProtocol(got)) => format!(
            "the tab's backend speaks protocol {got}, but its tab.json declares protocol {expected}; rebuild it against a matching SDK or update `backend.protocol`"
        ),
        Err(ReadyProblem::NoProtocol) => {
            format!("the tab's backend wrote `ready` without a protocol: expected `{wanted}`")
        }
    };
    Handshake::Failed(HandshakeFailure {
        kind: FailureKind::ProtocolMismatch,
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(handshake: Handshake) -> Option<FailureKind> {
        match handshake {
            Handshake::Failed(failure) => Some(failure.kind),
            _ => None,
        }
    }

    #[test]
    fn ready_must_name_the_declared_protocol() {
        assert_eq!(
            check_ready(br#"{"type":"ready","protocol":1}"#, 1),
            Handshake::Ready
        );
        assert_eq!(
            check_ready(
                br#"{"protocol":1,"type":"ready","sdk":"cadencr-tab-backend 0.1.0"}"#,
                1
            ),
            Handshake::Ready
        );
        let Handshake::Failed(other) = check_ready(br#"{"type":"ready","protocol":2}"#, 1) else {
            panic!("protocol 2 is not 1");
        };
        assert_eq!(other.kind, FailureKind::ProtocolMismatch);
        assert!(
            other.message.contains("speaks protocol 2"),
            "{}",
            other.message
        );
        assert!(
            other.message.contains("declares protocol 1"),
            "{}",
            other.message
        );
        for line in [
            &br#"{"type":"response","id":"1","result":null}"#[..],
            b"listening on 8080",
            br#"{"type":"ready","protocol":"1"}"#,
            br#"{"type":"ready"}"#,
            b"",
        ] {
            assert_eq!(
                kind(check_ready(line, 1)),
                Some(FailureKind::ProtocolMismatch),
                "{}",
                String::from_utf8_lossy(line)
            );
        }
        let Handshake::Failed(chatty) = check_ready(b"listening on 8080", 1) else {
            panic!("not a ready line");
        };
        assert!(chatty
            .message
            .contains(r#"expected `{"type":"ready","protocol":1}`"#));
        assert!(chatty.message.contains("got `listening on 8080`"));
    }

    #[test]
    fn failures_map_to_their_stable_codes() {
        let codes = [
            (
                HandshakeFailure::not_ready(READY_TIMEOUT),
                "PLUGIN_BACKEND_NOT_READY",
            ),
            (
                HandshakeFailure {
                    kind: FailureKind::ProtocolMismatch,
                    message: "m".into(),
                },
                "PLUGIN_BACKEND_PROTOCOL_MISMATCH",
            ),
            (
                HandshakeFailure::exited("exited with status 1"),
                "PLUGIN_BACKEND_EXITED",
            ),
        ];
        for (failure, expected) in codes {
            assert!(matches!(
                failure.to_error(),
                AppError::Coded { code, .. } if code == expected
            ));
        }
    }

    #[tokio::test]
    async fn the_first_outcome_wins() {
        let state = new_state();
        assert!(settle(&state, Handshake::Ready));
        assert!(!settle(
            &state,
            Handshake::Failed(HandshakeFailure::not_ready(READY_TIMEOUT))
        ));
        assert!(wait_ready(&state).await.is_ok());
        let failed_state = new_state();
        settle(
            &failed_state,
            Handshake::Failed(HandshakeFailure::exited("exited with status 3")),
        );
        assert_eq!(
            failed(&failed_state, READY_TIMEOUT).await.kind,
            FailureKind::Exited
        );
        assert!(matches!(
            wait_ready(&failed_state).await,
            Err(AppError::Coded {
                code: "PLUGIN_BACKEND_EXITED",
                ..
            })
        ));
    }
}
