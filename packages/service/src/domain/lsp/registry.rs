//! Pre-allocated LSP session registry.
//!
//! Two-step handshake: the renderer first `POST /api/lsp/sessions` to reserve
//! a session (so the WS URL can carry just an opaque id, no workspace/lang
//! query params), then upgrades `GET /api/lsp/sessions/:id/connect` to start
//! the proxy. The pending reservation is consumed by the upgrade — i.e. a
//! session id is single-use. Step 5 will let the same `(workspace, language)`
//! tuple share one running server across multiple WS clients via reference
//! counting; for now each session is its own child process.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::AppError;

use super::spawn::ServerSpec;

/// How long a reserved-but-unconnected session sticks around before being
/// garbage-collected. The renderer should upgrade within a few hundred
/// milliseconds of the POST; 30s is generous and bounds the leak from a
/// crashed renderer that opens sessions it never connects to.
const PENDING_TTL: Duration = Duration::from_secs(30);

/// Snapshot of what the renderer asked for, captured at POST time and replayed
/// when the WS upgrade lands. `language_id` follows LSP `TextDocumentItem`
/// language id conventions (`"typescript"`, `"rust"`, …); the renderer is
/// responsible for the language→id mapping (driven by the same catalog).
#[derive(Debug, Clone)]
pub struct SessionSpec {
    pub workspace_root: PathBuf,
    pub language_id: String,
    /// Binary resolved at POST time (discovery + optional download).
    /// Stashed here so the WS upgrade never has to re-resolve and can't
    /// drift from what the renderer was told the session would talk to.
    pub server: ServerSpec,
}

#[derive(Debug)]
struct Pending {
    spec: SessionSpec,
    created_at: Instant,
}

/// Reservations keyed by session id. Wrapped in [`Arc`] so it can live in
/// [`AppState`](crate::app_state::AppState) and be cheaply cloned per handler
/// invocation.
#[derive(Debug, Default)]
pub struct LspRegistry {
    pending: Mutex<HashMap<String, Pending>>,
}

impl LspRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Reserves a session and returns its id. The id is an opaque UUIDv4 so
    /// it is unguessable from the outside even though the WS route is already
    /// gated by the per-launch bearer token.
    pub async fn reserve(&self, spec: SessionSpec) -> String {
        self.evict_stale().await;
        let id = Uuid::new_v4().to_string();
        let mut pending = self.pending.lock().await;
        pending.insert(
            id.clone(),
            Pending {
                spec,
                created_at: Instant::now(),
            },
        );
        id
    }

    /// Atomically removes the reservation for `session_id` and returns its
    /// spec, or [`AppError::NotFound`] if it does not exist (typo, double-
    /// upgrade, or evicted after [`PENDING_TTL`]).
    pub async fn claim(&self, session_id: &str) -> Result<SessionSpec, AppError> {
        self.evict_stale().await;
        let mut pending = self.pending.lock().await;
        pending
            .remove(session_id)
            .map(|p| p.spec)
            .ok_or_else(|| AppError::NotFound(format!("lsp session {session_id}")))
    }

    async fn evict_stale(&self) {
        let now = Instant::now();
        let mut pending = self.pending.lock().await;
        pending.retain(|_, p| now.duration_since(p.created_at) < PENDING_TTL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(lang: &str) -> SessionSpec {
        SessionSpec {
            workspace_root: PathBuf::from("/tmp/example"),
            language_id: lang.to_string(),
            server: ServerSpec {
                command: PathBuf::from("/usr/bin/true"),
                args: vec![],
                display_name: "stub".into(),
                managed_revision: None,
            },
        }
    }

    #[tokio::test]
    async fn reserve_then_claim_returns_spec() {
        let reg = LspRegistry::new();
        let id = reg.reserve(spec("typescript")).await;
        let got = reg.claim(&id).await.expect("claim ok");
        assert_eq!(got.language_id, "typescript");
    }

    #[tokio::test]
    async fn claim_is_single_use() {
        let reg = LspRegistry::new();
        let id = reg.reserve(spec("typescript")).await;
        reg.claim(&id).await.expect("first claim");
        let err = reg.claim(&id).await.unwrap_err();
        matches!(err, AppError::NotFound(_));
    }

    #[tokio::test]
    async fn unknown_session_is_not_found() {
        let reg = LspRegistry::new();
        let err = reg.claim("does-not-exist").await.unwrap_err();
        matches!(err, AppError::NotFound(_));
    }

    #[tokio::test]
    async fn reservations_have_unique_ids() {
        let reg = LspRegistry::new();
        let a = reg.reserve(spec("typescript")).await;
        let b = reg.reserve(spec("typescript")).await;
        assert_ne!(a, b);
    }
}
