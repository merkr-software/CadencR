//! Provider-neutral capability for branching a runtime session's context at a
//! point in time. Both rewind (in place) and fork (new session) drive the same
//! `truncate_before` contract — the rewind-vs-fork distinction is an
//! orchestration concern, not a provider one.
//!
//! Providers that can't (yet) branch simply don't implement it; the adapter's
//! default `session_branching()` returns `None` and the orchestrator reports the
//! action unsupported. The only provider-aware code is the impl behind this
//! trait (today: Claude Code's JSONL surgery).

use std::path::PathBuf;

use async_trait::async_trait;

/// Inputs for a single branch operation.
pub struct BranchContext {
    /// Worktree the session runs in. Both the provider transcript location and
    /// the (unchanged) code live here.
    pub cwd: PathBuf,
    /// The provider session being branched from.
    pub source_runtime_session_id: String,
    /// The cut message's own provider id (Claude `uuid`), when known. Preferred
    /// over the ordinal because it's robust to transcript reshaping; `None`
    /// falls back to `cut_user_ordinal`.
    pub cut_provider_uuid: Option<String>,
    /// 1-indexed position of the cut user prompt among the session's user
    /// prompts. The transcript is cut immediately before the Nth real user
    /// prompt, keeping everything earlier. `0`/`1` means "keep nothing before
    /// the first prompt" (a fresh context).
    pub cut_user_ordinal: usize,
}

/// Result of a successful branch: the new provider session id whose context
/// ends immediately before the cut point.
#[derive(Debug)]
pub struct BranchResult {
    pub new_runtime_session_id: String,
}

/// Failure modes for a branch. The orchestrator treats both as hard aborts: it
/// stops the rewind/fork *before* any code or conversation mutation and surfaces
/// the message, rather than silently completing against the full history.
#[derive(Debug)]
pub enum BranchError {
    /// The provider can't branch this session (e.g. missing transcript).
    Unsupported(String),
    /// The transcript surgery itself failed (parse error, format drift, I/O).
    Surgery(String),
}

impl std::fmt::Display for BranchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BranchError::Unsupported(msg) => write!(f, "branching unsupported: {msg}"),
            BranchError::Surgery(msg) => write!(f, "transcript surgery failed: {msg}"),
        }
    }
}

impl std::error::Error for BranchError {}

#[async_trait]
pub trait SessionBranching: Send + Sync {
    /// Produce a NEW provider session id whose context ends immediately before
    /// the cut point described by `ctx`. Used by both rewind and fork.
    async fn truncate_before(&self, ctx: &BranchContext) -> Result<BranchResult, BranchError>;
}
