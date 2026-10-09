mod adapter_impl;
mod auto_mode;
mod background_agents;
mod branching;
mod catalog;
mod context_windows;
pub mod custom_models;
mod events;
mod jsonl_surgery;
mod model_alias;
mod post_plan_approval;
mod profile_adapter;
pub mod profiles;
mod prompt_receipts;
pub(crate) mod question_answers;
pub mod routes;
mod runtime_error;
mod session;
mod slash_catalog;
mod worktree_config;

// Only referenced from this crate's test support; re-exported so the
// `claude_code::ClaudeCodeSession` path stays stable.
#[cfg(test)]
pub use self::session::ClaudeCodeSession;

pub const PROVIDER_ID: &str = "claude_code";

/// Process-lifetime capability handle for point-in-time branching (rewind /
/// fork). A ZST, so a `static` is free and lets the adapter hand out a
/// `&'static dyn SessionBranching`.
static CLAUDE_SESSION_BRANCHING: branching::ClaudeSessionBranching =
    branching::ClaudeSessionBranching;

use crate::domain::agents::adapter::RuntimeSlashCommand;
use crate::domain::agents::runtime::ModelCatalogEntry;

pub struct ClaudeCodeAdapter {
    /// Process-lifetime cache of the model catalog. Pre-populated with a
    /// static fallback list of the historical aliases so the UI has
    /// something to show before the CLI probe completes; replaced with the
    /// live CLI-reported list on first successful probe.
    cached_models: std::sync::OnceLock<std::sync::RwLock<Vec<ModelCatalogEntry>>>,
    /// Serialises concurrent probes and tracks whether the cached list is
    /// already authoritative (live from the CLI). Unlike `OnceCell`, this
    /// lets failures be TTL-throttled and retried later — the UI would
    /// otherwise be stuck on fallback aliases until service restart.
    probe_state: tokio::sync::Mutex<ProbeState>,
    /// Cache of CLI built-in slash commands. Cwd-invariant, so one cache
    /// serves every session; per-cwd filesystem entries are scanned fresh.
    /// Same process-lifetime semantics as `cached_models` / `probe_state`.
    cached_slash_commands: std::sync::OnceLock<std::sync::RwLock<Vec<RuntimeSlashCommand>>>,
    slash_commands_probe_state: tokio::sync::Mutex<ProbeState>,
    /// Context windows learned from `result.modelUsage`, keyed by the CLI's
    /// model id. The CLI advertises no window in its catalog or `init`, so
    /// this is the only way a model's window is known before its first
    /// `result`. Loaded from disk on first use and written back whenever a
    /// window is learned, so it outlives the process (see `context_windows`).
    cached_context_windows: std::sync::OnceLock<std::sync::RwLock<context_windows::LearnedWindows>>,
}

#[derive(Default)]
struct ProbeState {
    live: bool,
    live_key: Option<catalog::ModelProbeCacheKey>,
    failed_key: Option<catalog::ModelProbeCacheKey>,
    failed_at: Option<std::time::Instant>,
    failure_message: Option<String>,
}

pub static CLAUDE_CODE_ADAPTER: ClaudeCodeAdapter = ClaudeCodeAdapter {
    cached_models: std::sync::OnceLock::new(),
    probe_state: tokio::sync::Mutex::const_new(ProbeState {
        live: false,
        live_key: None,
        failed_key: None,
        failed_at: None,
        failure_message: None,
    }),
    cached_slash_commands: std::sync::OnceLock::new(),
    slash_commands_probe_state: tokio::sync::Mutex::const_new(ProbeState {
        live: false,
        live_key: None,
        failed_key: None,
        failed_at: None,
        failure_message: None,
    }),
    cached_context_windows: std::sync::OnceLock::new(),
};

/// Seed the static `CLAUDE_CODE_ADAPTER`'s model catalog from a test.
/// Crate-visible so tests in other modules (e.g. the post-plan-mode
/// orchestrator) can drive `post_plan_approval_mode_wire` to a known
/// outcome without needing access to the private cache cell.
#[cfg(test)]
pub(crate) fn seed_static_catalog_for_tests(models: Vec<ModelCatalogEntry>) {
    let cell = CLAUDE_CODE_ADAPTER.models_cell();
    if let Ok(mut guard) = cell.write() {
        *guard = models;
    }
}

/// Shared fixtures for the `claude_code` submodules' unit tests. Kept here
/// (rather than duplicated per submodule) so the `adapter_impl` and
/// `post_plan_approval` tests build adapters and seed catalogs identically.
#[cfg(test)]
mod test_support {
    use super::{ClaudeCodeAdapter, ProbeState};
    use crate::domain::agents::runtime::ModelCatalogEntry;

    pub(super) fn new_test_adapter() -> ClaudeCodeAdapter {
        ClaudeCodeAdapter {
            cached_models: std::sync::OnceLock::new(),
            probe_state: tokio::sync::Mutex::new(ProbeState::default()),
            cached_slash_commands: std::sync::OnceLock::new(),
            slash_commands_probe_state: tokio::sync::Mutex::new(ProbeState::default()),
            cached_context_windows: std::sync::OnceLock::new(),
        }
    }

    pub(super) fn seed_models(adapter: &ClaudeCodeAdapter, models: Vec<ModelCatalogEntry>) {
        let cell = adapter.models_cell();
        let mut guard = cell.write().expect("cache lock");
        *guard = models;
    }

    pub(super) fn model_with_auto(id: &str, supports_auto: Option<bool>) -> ModelCatalogEntry {
        ModelCatalogEntry {
            id: id.to_string(),
            label: id.to_string(),
            description: None,
            supports_effort: None,
            supported_effort_levels: None,
            default_effort_level: None,
            supports_adaptive_thinking: None,
            supports_fast_mode: None,
            supports_auto_mode: supports_auto,
        }
    }
}
